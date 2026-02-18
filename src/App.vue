<template>
  <div class="app">
    <div class="container">
      <h1>🎙️ 语音助手</h1>
      
      <!-- Voice Button -->
      <button 
        class="voice-button" 
        :class="{ listening: isListening }"
        @mousedown="startRecording"
        @mouseup="stopRecording"
        @touchstart.prevent="startRecording"
        @touchend.prevent="stopRecording"
      >
        {{ isListening ? '正在听...' : (continuousMode ? '点击说话' : '按住说话') }}
      </button>
      
      <!-- Continuous Mode Toggle -->
      <div class="continuous-toggle">
        <label class="toggle-switch">
          <input type="checkbox" v-model="continuousMode">
          <span class="toggle-slider"></span>
        </label>
        <span class="toggle-label">连续对话</span>
      </div>
      
      <!-- Status -->
      <p class="status" :class="{ active: isListening || isProcessing }">{{ statusText }}</p>
      
      <!-- Transcript -->
      <div class="transcript-box">
        <h3>对话</h3>
        <div v-if="!transcript && !aiResponse" class="empty-tip">
          {{ continuousMode ? '点击按钮开始对话' : '按住按钮说话' }}
        </div>
        <div v-else>
          <p v-if="transcript" class="user"><strong>你:</strong> {{ transcript }}</p>
          <p v-if="aiResponse" class="assistant"><strong>AI:</strong> {{ aiResponse }}</p>
        </div>
      </div>
      
      <!-- Controls -->
      <div class="controls">
        <button @click="clearHistory">清除记录</button>
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
      isListening: false,
      isProcessing: false,
      continuousMode: false,
      statusText: '就绪',
      transcript: '',
      aiResponse: '',
      
      // Audio
      mediaStream: null,
      audioContext: null,
      audioProcessor: null,
      audioSource: null,
      
      // Config
      serverUrl: 'ws://154.89.149.198:8765/ws'
    }
  },
  mounted() {
    this.connectWebSocket()
  },
  beforeUnmount() {
    this.disconnect()
  },
  methods: {
    connectWebSocket() {
      this.statusText = '连接中...'
      
      this.ws = new WebSocket(this.serverUrl)
      
      this.ws.onopen = () => {
        console.log('WS Connected')
        this.isConnected = true
        this.statusText = '就绪'
      }

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)
          console.log('WS:', data.type)
          this.handleMessage(data)
        } catch (e) {
          console.error('Parse error:', e)
        }
      }

      this.ws.onclose = () => {
        console.log('WS Disconnected')
        this.isConnected = false
        this.statusText = '断开连接'
        setTimeout(() => this.connectWebSocket(), 3000)
      }

      this.ws.onerror = (err) => {
        console.error('WS Error:', err)
        this.statusText = '连接错误'
      }
    },

    handleMessage(data) {
      const { type, text } = data
      
      switch (type) {
        case 'listening_started':
          this.isListening = true
          this.statusText = this.continuousMode ? '🎙️ 正在听...' : '正在听...'
          break
          
        case 'listening_stopped':
          this.isListening = false
          this.statusText = '处理中...'
          break
          
        case 'transcript':
          if (data.final) {
            this.transcript = text
            this.statusText = 'AI 回复中...'
          }
          break
          
        case 'response_chunk':
          this.aiResponse = (this.aiResponse || '') + text
          this.statusText = '说话中...'
          break
          
        case 'audio_chunk':
          this.playAudioChunk(data.data)
          break
          
        case 'response_complete':
          this.isProcessing = false
          this.statusText = this.continuousMode ? '🎙️ 就绪' : '就绪'
          if (this.continuousMode) {
            setTimeout(() => this.startRecording(), 500)
          }
          break
      }
    },

    async startRecording() {
      if (this.isListening || this.isProcessing) return
      
      try {
        // Get microphone
        if (!this.mediaStream) {
          this.mediaStream = await navigator.mediaDevices.getUserMedia({ 
            audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true }
          })
        }
        
        // Setup audio processing
        this.audioContext = new AudioContext({ sampleRate: 16000 })
        this.audioSource = this.audioContext.createMediaStreamSource(this.mediaStream)
        this.audioProcessor = this.audioContext.createScriptProcessor(4096, 1, 1)
        
        this.audioProcessor.onaudioprocess = (e) => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            const audioData = e.inputBuffer.getChannelData(0)
            const base64 = this.float32ToBase64(audioData)
            this.ws.send(JSON.stringify({ type: 'audio', data: base64 }))
          }
        }
        
        this.audioSource.connect(this.audioProcessor)
        this.audioProcessor.connect(this.audioContext.destination)
        
        this.isListening = true
        this.transcript = ''
        this.aiResponse = ''
        
        this.ws.send(JSON.stringify({ type: 'start_listening' }))
        
      } catch (e) {
        console.error('Recording error:', e)
        alert('无法打开麦克风: ' + e.message)
      }
    },

    stopRecording() {
      if (!this.isListening) return
      
      this.isListening = false
      
      if (this.audioProcessor) {
        this.audioProcessor.disconnect()
        this.audioProcessor = null
      }
      
      if (!this.continuousMode && this.audioSource) {
        this.audioSource.disconnect()
        this.audioSource = null
      }
      
      if (this.audioContext) {
        this.audioContext.close()
        this.audioContext = null
      }
      
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'stop_listening' }))
      }
    },

    playAudioChunk(base64Data) {
      try {
        const binary = atob(base64Data)
        const bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i)
        }
        
        const int16Array = new Int16Array(bytes.buffer)
        const float32Array = new Float32Array(int16Array.length)
        for (let i = 0; i < int16Array.length; i++) {
          float32Array[i] = int16Array[i] / 32768.0
        }
        
        const audioCtx = new AudioContext()
        const buffer = audioCtx.createBuffer(1, float32Array.length, 16000)
        buffer.getChannelData(0).set(float32Array)
        
        const source = audioCtx.createBufferSource()
        source.buffer = buffer
        source.connect(audioCtx.destination)
        source.start()
      } catch (e) {
        console.error('Playback error:', e)
      }
    },

    float32ToBase64(float32Array) {
      const bytes = new Uint8Array(float32Array.buffer)
      let binary = ''
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i])
      }
      return btoa(binary)
    },

    clearHistory() {
      this.transcript = ''
      this.aiResponse = ''
    },

    disconnect() {
      this.stopRecording()
      if (this.mediaStream) {
        this.mediaStream.getTracks().forEach(track => track.stop())
        this.mediaStream = null
      }
      if (this.ws) {
        this.ws.close()
        this.ws = null
      }
    }
  }
}
</script>

<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
  color: #fff;
  min-height: 100vh;
}
.app {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 20px;
}

.container {
  max-width: 600px;
  width: 100%;
  text-align: center;
}

h1 {
  font-size: 2rem;
  margin-bottom: 10px;
  background: linear-gradient(90deg, #ff6b35, #f7c94b);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}

.voice-button {
  width: 150px;
  height: 150px;
  border-radius: 50%;
  border: none;
  background: linear-gradient(135deg, #ff6b35 0%, #e55a2b 100%);
  color: white;
  font-size: 1.2rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.3s ease;
  box-shadow: 0 10px 40px rgba(255, 107, 53, 0.3);
  margin: 30px auto;
}

.voice-button:active,
.voice-button.listening {
  transform: scale(0.95);
  animation: pulse 1.5s infinite;
}

@keyframes pulse {
  0%, 100% { box-shadow: 0 10px 40px rgba(255, 107, 53, 0.3); }
  50% { box-shadow: 0 10px 60px rgba(255, 107, 53, 0.6); }
}

.continuous-toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  margin-bottom: 20px;
}

.toggle-switch {
  position: relative;
  width: 56px;
  height: 30px;
}

.toggle-switch input {
  opacity: 0;
  width: 0;
  height: 0;
}

.toggle-slider {
  position: absolute;
  cursor: pointer;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: #333;
  border-radius: 30px;
  transition: 0.3s;
}

.toggle-slider:before {
  position: absolute;
  content: "";
  height: 22px;
  width: 22px;
  left: 4px;
  bottom: 4px;
  background: white;
  border-radius: 50%;
  transition: 0.3s;
}

.toggle-switch input:checked + .toggle-slider {
  background: #ff6b35;
}

.toggle-switch input:checked + .toggle-slider:before {
  transform: translateX(26px);
}

.toggle-label {
  font-weight: 600;
  color: #fff;
}

.status {
  font-size: 1.1rem;
  color: #888;
  margin-bottom: 20px;
}

.status.active {
  color: #ff6b35;
}

.transcript-box {
  background: rgba(255, 255, 255, 0.05);
  border-radius: 12px;
  padding: 20px;
  margin-bottom: 20px;
  text-align: left;
  min-height: 100px;
}

.transcript-box h3 {
  font-size: 0.9rem;
  color: #666;
  margin-bottom: 10px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
}

.transcript-box p {
  font-size: 1rem;
  line-height: 1.6;
  margin-bottom: 10px;
}

.transcript-box p.user {
  color: #ff6b35;
}

.transcript-box p.assistant {
  color: #4fc3f7;
}

.empty-tip {
  color: #666;
  text-align: center;
  padding: 20px;
}

.controls {
  display: flex;
  gap: 10px;
  justify-content: center;
}

.controls button {
  padding: 10px 20px;
  border: 1px solid #444;
  background: transparent;
  color: #888;
  border-radius: 8px;
  cursor: pointer;
  font-size: 0.9rem;
}

.controls button:hover {
  border-color: #ff6b35;
  color: #ff6b35;
}
</style>
