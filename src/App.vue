<template>
  <div class="app">
    <!-- Call Button -->
    <div class="call-container">
      <button 
        class="call-btn" 
        :class="{ active: inCallMode }"
        @click="toggleCall"
      >
        <span class="phone-icon">{{ inCallMode ? '📞' : '📴' }}</span>
      </button>
      
      <!-- Status -->
      <div class="status-text">
        {{ getStatusText() }}
      </div>
      
      <!-- Debug Info -->
      <div class="debug-info" v-if="showDebug">
        <div>VAD: {{ vadActive ? 'ON' : 'OFF' }}</div>
        <div>Listening: {{ isListening ? 'YES' : 'NO' }}</div>
        <div>Processing: {{ isProcessing ? 'YES' : 'NO' }}</div>
        <div v-if="transcript">ASR: {{ transcript }}</div>
        <div v-if="aiResponse">AI: {{ aiResponse }}</div>
      </div>
    </div>
  </div>
</template>

<script>
export default {
  name: 'App',
  data() {
    return {
      ws: null,
      isConnected: false,
      inCallMode: false,
      isListening: false,
      isProcessing: false,
      callStatus: 'idle',
      
      // Audio
      stream: null,
      audioContext: null,
      mediaRecorder: null,
      audioChunks: [],
      
      // Config - OpenClaw Voice protocol
      serverUrl: 'ws://154.89.149.198:8765/ws',
      showDebug: true,
      transcript: '',
      aiResponse: ''
    }
  },
  mounted() {
    this.connectWebSocket()
  },
  beforeUnmount() {
    this.leaveCallMode()
    this.disconnectWebSocket()
  },
  methods: {
    // ===== WebSocket =====
    connectWebSocket() {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) return
      
      this.callStatus = 'connecting'
      console.log('Connecting to', this.serverUrl)
      
      try {
        this.ws = new WebSocket(this.serverUrl)
        
        this.ws.onopen = () => {
          console.log('WS Connected')
          this.isConnected = true
          this.callStatus = 'ready'
        }

        this.ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data)
            console.log('WS Received:', data.type)
            this.handleMessage(data)
          } catch (e) {
            console.error('Parse error:', e)
          }
        }

        this.ws.onclose = () => {
          console.log('WS Disconnected')
          this.isConnected = false
          this.callStatus = 'disconnected'
          if (this.inCallMode) {
            setTimeout(() => this.connectWebSocket(), 3000)
          }
        }

        this.ws.onerror = (err) => {
          console.error('WS Error:', err)
          this.callStatus = 'error'
        }
      } catch (e) {
        console.error('WS Creation error:', e)
        this.callStatus = 'error'
      }
    },

    disconnectWebSocket() {
      if (this.ws) {
        this.ws.close()
        this.ws = null
      }
    },

    send(data) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(data))
      }
    },

    handleMessage(data) {
      const { type, text, final } = data

      switch (type) {
        case 'listening_started':
          console.log('Started listening')
          this.isListening = true
          break
          
        case 'listening_stopped':
          console.log('Stopped listening')
          this.isListening = false
          break
          
        case 'transcript':
          if (final) {
            this.transcript = text
            console.log('Final transcript:', text)
          }
          break
          
        case 'response_chunk':
          this.aiResponse = (this.aiResponse || '') + text
          break
          
        case 'audio_chunk':
          // Play audio chunk
          this.playAudioChunk(data.data)
          break
          
        case 'response_complete':
          console.log('Response complete:', text)
          this.isProcessing = false
          this.callStatus = 'ready'
          // Restart listening
          this.startListening()
          break
          
        case 'vad_status':
          console.log('VAD:', data.speech_detected)
          break
      }
    },

    // ===== Call Control =====
    async toggleCall() {
      if (this.inCallMode) {
        this.leaveCallMode()
      } else {
        await this.enterCallMode()
      }
    },

    async enterCallMode() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        alert('抱歉，您的浏览器不支持语音功能。\n\n请使用 APP 版本')
        return
      }
      
      try {
        this.inCallMode = true
        this.callStatus = 'connecting'
        
        // Connect WebSocket
        if (!this.isConnected) {
          this.connectWebSocket()
          await new Promise(resolve => setTimeout(resolve, 2000))
        }
        
        // Request microphone
        this.stream = await navigator.mediaDevices.getUserMedia({ 
          audio: { 
            echoCancellation: true, 
            noiseSuppression: true,
            autoGainControl: true
          } 
        })
        
        // Setup audio context
        this.audioContext = new (window.AudioContext || window.webkitAudioContext)()
        if (this.audioContext.state === 'suspended') {
          await this.audioContext.resume()
        }
        
        this.callStatus = 'ready'
        
        // Start listening
        this.startListening()
        
      } catch (e) {
        console.error('Failed to enter call mode:', e)
        this.inCallMode = false
        this.callStatus = 'error'
        alert('无法打开麦克风: ' + e.message)
      }
    },

    leaveCallMode() {
      this.inCallMode = false
      this.stopListening()
      
      if (this.stream) {
        this.stream.getTracks().forEach(track => track.stop())
        this.stream = null
      }
      
      if (this.audioContext) {
        this.audioContext.close()
        this.audioContext = null
      }
      
      this.callStatus = 'idle'
    },

    // ===== Audio Recording =====
    startListening() {
      if (!this.stream || !this.audioContext) return
      
      this.isListening = true
      this.transcript = ''
      this.aiResponse = ''
      
      // Send start_listening
      this.send({ type: 'start_listening' })
      
      // Create audio recorder
      this.mediaRecorder = new MediaRecorder(this.stream, {
        mimeType: 'audio/webm;codecs=opus'
      })
      
      this.audioChunks = []
      
      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          this.audioChunks.push(e.data)
        }
      }
      
      this.mediaRecorder.onstop = () => {
        this.processAudio()
      }
      
      // Start recording with timeslice
      this.mediaRecorder.start(100)
    },

    stopListening() {
      if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
        this.mediaRecorder.stop()
      }
      this.isListening = false
      
      // Send stop_listening
      this.send({ type: 'stop_listening' })
    },

    async processAudio() {
      if (this.audioChunks.length === 0) return
      
      this.isProcessing = true
      this.callStatus = 'processing'
      this.stopListening()
      
      try {
        // Convert to PCM float32
        const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm' })
        const arrayBuffer = await audioBlob.arrayBuffer()
        const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer)
        
        // Get PCM data
        const channelData = audioBuffer.getChannelData(0)
        
        // Convert to base64
        const pcmData = this.floatToBase64(channelData)
        
        // Send audio
        this.send({
          type: 'audio',
          data: pcmData
        })
        
      } catch (e) {
        console.error('Audio processing error:', e)
        this.isProcessing = false
        this.callStatus = 'ready'
        this.startListening()
      }
      
      this.audioChunks = []
    },

    floatToBase64(float32Array) {
      // Convert float32 to 16-bit PCM
      const int16Array = new Int16Array(float32Array.length)
      for (let i = 0; i < float32Array.length; i++) {
        const s = Math.max(-1, Math.min(1, float32Array[i]))
        int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7FFF
      }
      
      // Convert to base64
      let binary = ''
      const bytes = new Uint8Array(int16Array.buffer)
      for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i])
      }
      return btoa(binary)
    },

    // ===== Audio Playback =====
    playAudioChunk(base64Data) {
      try {
        const binary = atob(base64Data)
        const bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i)
        }
        
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)()
        const audioBuffer = audioCtx.createBuffer(1, bytes.length / 2, 16000)
        const channelData = audioBuffer.getChannelData(0)
        
        const int16Array = new Int16Array(bytes.buffer)
        for (let i = 0; i < int16Array.length; i++) {
          channelData[i] = int16Array[i] / 32768.0
        }
        
        const source = audioCtx.createBufferSource()
        source.buffer = audioBuffer
        source.connect(audioCtx.destination)
        source.start()
      } catch (e) {
        console.error('Playback error:', e)
      }
    },

    // ===== UI =====
    getStatusText() {
      switch (this.callStatus) {
        case 'idle': return '点击拨打'
        case 'connecting': return '连接中...'
        case 'ready': return '请说话'
        case 'listening': return '正在听...'
        case 'processing': return 'AI 处理中...'
        case 'disconnected': return '断开连接'
        case 'error': return '连接错误'
        default: return ''
      }
    }
  }
}
</script>

<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: #1a1a1a;
  height: 100vh;
  display: flex;
  justify-content: center;
  align-items: center;
}
.app {
  width: 100%;
  height: 100%;
  display: flex;
  justify-content: center;
  align-items: center;
}

.call-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 30px;
}

.call-btn {
  width: 120px;
  height: 120px;
  border-radius: 60px;
  border: none;
  background: #333;
  cursor: pointer;
  transition: all 0.3s;
  box-shadow: 0 4px 20px rgba(0,0,0,0.3);
}

.call-btn.active {
  background: #34c759;
  animation: call-pulse 2s infinite;
}

.phone-icon {
  font-size: 48px;
}

@keyframes call-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(52, 199, 89, 0.4); }
  50% { box-shadow: 0 0 0 20px rgba(52, 199, 89, 0); }
}

.status-text {
  font-size: 18px;
  color: #666;
  min-height: 24px;
}

.debug-info {
  font-size: 12px;
  color: #888;
  text-align: center;
  margin-top: 20px;
  line-height: 1.6;
}
</style>
