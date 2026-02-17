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
      isRecording: false,
      isProcessing: false,
      callStatus: 'idle', // idle, connecting, ready, listening, processing, speaking
      
      // Audio
      stream: null,
      audioContext: null,
      analyser: null,
      mediaRecorder: null,
      audioChunks: [],
      vadInterval: null,
      
      // Config
      userId: 'user_' + Math.random().toString(36).substr(2, 9),
      serverUrl: 'ws://154.89.149.198:8765/ws',
      token: 'voice_9527_secret_key_2026',
      vadThreshold: 0.01,
      vadSilenceThreshold: 1500,
      lastSpeechTime: 0
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
          this.send({ action: 'auth', payload: { userId: this.userId, token: this.token }})
        }

        this.ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data)
            console.log('WS Received:', data.action)
            this.handleMessage(data)
          } catch (e) {
            console.error('Parse error:', e)
          }
        }

        this.ws.onclose = () => {
          console.log('WS Disconnected')
          this.isConnected = false
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
      const { action, payload } = data

      switch (action) {
        case 'auth_ok':
          console.log('Auth OK')
          if (this.inCallMode) {
            this.callStatus = 'ready'
          }
          break

        case 'typing':
          this.callStatus = 'processing'
          break

        case 'asr_result':
          // User speech recognized
          break

        case 'reply':
          this.isProcessing = false
          this.callStatus = 'speaking'
          
          // Auto-play audio
          if (payload.audioUrl) {
            this.playAudio(payload.audioUrl)
          } else {
            this.callStatus = 'ready'
          }
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
      // Check if browser supports getUserMedia
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        alert('抱歉，您的浏览器不支持语音功能。\n\n请使用以下方式：\n1. 安装 APP 版本\n2. 或使用 HTTPS 访问')
        return
      }
      
      try {
        this.inCallMode = true
        this.callStatus = 'connecting'
        
        // Ensure WebSocket connected
        if (!this.isConnected) {
          this.connectWebSocket()
        }
        
        // Wait for connection
        await new Promise(resolve => setTimeout(resolve, 1000))
        
        // Request microphone
        this.stream = await navigator.mediaDevices.getUserMedia({ 
          audio: { echoCancellation: true, noiseSuppression: true } 
        })
        
        // Setup audio analysis for VAD
        this.audioContext = new (window.AudioContext || window.webkitAudioContext)()
        const source = this.audioContext.createMediaStreamSource(this.stream)
        this.analyser = this.audioContext.createAnalyser()
        this.analyser.fftSize = 256
        source.connect(this.analyser)
        
        this.callStatus = 'ready'
        this.startVAD()
        
      } catch (e) {
        console.error('Failed to enter call mode:', e)
        this.inCallMode = false
        this.callStatus = 'error'
        alert('无法打开麦克风: ' + e.message)
      }
    },

    leaveCallMode() {
      this.inCallMode = false
      this.stopVAD()
      
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

    // ===== VAD =====
    startVAD() {
      const dataArray = new Uint8Array(this.analyser.frequencyBinCount)
      
      this.vadInterval = setInterval(() => {
        if (this.isRecording || this.isProcessing) return
        
        this.analyser.getByteFrequencyData(dataArray)
        const average = dataArray.reduce((a, b) => a + b) / dataArray.length
        const volume = average / 255
        
        const now = Date.now()
        
        if (volume > this.vadThreshold) {
          this.lastSpeechTime = now
          if (!this.isRecording) {
            this.startRecording()
          }
        } else {
          if (this.isRecording && (now - this.lastSpeechTime) > this.vadSilenceThreshold) {
            this.stopRecording()
          }
        }
      }, 100)
    },

    stopVAD() {
      if (this.vadInterval) {
        clearInterval(this.vadInterval)
        this.vadInterval = null
      }
    },

    // ===== Recording =====
    startRecording() {
      if (this.isRecording) return
      
      try {
        this.mediaRecorder = new MediaRecorder(this.stream)
        this.audioChunks = []

        this.mediaRecorder.ondataavailable = (e) => {
          if (e.data.size > 0) this.audioChunks.push(e.data)
        }

        this.mediaRecorder.onstop = () => {
          this.sendAudio()
        }

        this.mediaRecorder.start()
        this.isRecording = true
        this.callStatus = 'listening'
      } catch (e) {
        console.error('Recording error:', e)
      }
    },

    stopRecording() {
      if (!this.isRecording) return
      
      if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
        this.mediaRecorder.stop()
      }
      this.isRecording = false
    },

    async sendAudio() {
      if (this.audioChunks.length === 0) return

      this.isProcessing = true
      this.callStatus = 'processing'
      
      const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm' })
      
      // Convert to wav using AudioContext
      const arrayBuffer = await audioBlob.arrayBuffer()
      const audioCtx = new AudioContext()
      const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer)
      
      // Convert to WAV
      const wavBlob = this.audioBufferToWav(audioBuffer)
      const reader = new FileReader()
      
      reader.onload = () => {
        const base64 = reader.result.split(',')[1]
        
        this.send({
          action: 'audio',
          payload: { userId: this.userId, data: base64, format: 'wav' }
        })
        
        this.audioChunks = []
        audioCtx.close()
      }
      
      reader.readAsDataURL(wavBlob)
    },
    
    audioBufferToWav(buffer) {
      const numChannels = buffer.numberOfChannels
      const sampleRate = buffer.sampleRate
      const format = 1 // PCM
      const bitDepth = 16
      
      const result = this.interleave(buffer)
      const dataLength = result.length * 2
      const headerLength = 44
      const totalLength = headerLength + dataLength
      
      const header = new ArrayBuffer(headerLength)
      const view = new DataView(header)
      
      const writeString = (view, offset, string) => {
        for (let i = 0; i < string.length; i++) {
          view.setUint8(offset + i, string.charCodeAt(i))
        }
      }
      
      writeString(view, 0, 'RIFF')
      view.setUint32(4, 36 + dataLength, true)
      writeString(view, 8, 'WAVE')
      writeString(view, 12, 'fmt ')
      view.setUint32(16, 16, true)
      view.setUint16(20, format, true)
      view.setUint16(22, numChannels, true)
      view.setUint32(24, sampleRate, true)
      view.setUint32(28, sampleRate * numChannels * 2, true)
      view.setUint16(32, numChannels * 2, true)
      view.setUint16(34, bitDepth, true)
      writeString(view, 36, 'data')
      view.setUint32(40, dataLength, true)
      
      const wavData = new Int16Array(result)
      const wavBlob = new Blob([header, wavData], { type: 'audio/wav' })
      return wavBlob
    },
    
    interleave(buffer) {
      const numChannels = buffer.numberOfChannels
      const length = buffer.length
      const result = new Float32Array(length * numChannels)
      
      const channels = []
      for (let i = 0; i < numChannels; i++) {
        channels.push(buffer.getChannelData(i))
      }
      
      let index = 0
      for (let i = 0; i < length; i++) {
        for (let j = 0; j < numChannels; j++) {
          result[index++] = channels[j][i]
        }
      }
      
      return result
    },

    // ===== Audio Playback =====
    playAudio(url) {
      const audio = new Audio(url)
      
      audio.onended = () => {
        console.log('Playback ended')
        this.callStatus = 'ready'
      }
      
      audio.onerror = (e) => {
        console.error('Playback error:', e)
        this.callStatus = 'ready'
      }
      
      audio.play().catch(e => console.error('Play failed:', e))
    },

    // ===== UI =====
    getStatusText() {
      switch (this.callStatus) {
        case 'idle': return '点击拨打'
        case 'connecting': return '连接中...'
        case 'ready': return '请说话'
        case 'listening': return '正在听...'
        case 'processing': return 'AI 处理中...'
        case 'speaking': return 'AI 说话中...'
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
</style>
