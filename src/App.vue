<template>
  <div class="app">
    <!-- Status Bar -->
    <div class="status-bar">
      <div class="status" :class="{ connected: isConnected }">
        <span class="dot"></span>
        {{ isConnected ? '已连接' : '连接中...' }}
      </div>
    </div>

    <!-- Chat Area -->
    <div class="chat-area" ref="chatArea">
      <div v-if="messages.length === 0" class="empty-tip">
        <p>{{ inCallMode ? '🎙️ 通话中...' : '👋 长按麦克风说话' }}</p>
        <p class="sub" v-if="!inCallMode">松开发送语音</p>
      </div>
      
      <div
        v-for="(msg, index) in messages"
        :key="index"
        class="message"
        :class="{ 'user': msg.role === 'user', 'ai': msg.role === 'ai' }"
      >
        <div class="bubble">
          <p>{{ msg.text }}</p>
        </div>
      </div>

      <!-- Typing Indicator -->
      <div v-if="isTyping" class="typing">
        <span class="dot"></span>
        <span class="dot"></span>
        <span class="dot"></span>
      </div>
    </div>

    <!-- Call Mode Indicator -->
    <div v-if="inCallMode" class="call-indicator">
      <div class="call-pulse"></div>
      <span>通话中</span>
      <span class="call-status">{{ callStatus }}</span>
    </div>

    <!-- Input Area -->
    <div class="input-area">
      <!-- Call Button -->
      <button 
        class="call-btn" 
        :class="{ active: inCallMode }"
        @click="toggleCallMode"
      >
        <span class="phone-icon">📞</span>
      </button>

      <!-- Text Input (only when not in call mode) -->
      <template v-if="!inCallMode">
        <input
          v-model="textInput"
          type="text"
          placeholder="输入文字..."
          @keyup.enter="sendText"
        />
        <button class="send-btn" @click="sendText" :disabled="!textInput.trim()">
          发送
        </button>
      </template>

      <!-- Voice Button -->
      <button
        class="voice-btn"
        :class="{ recording: isRecording, listening: inCallMode && !isProcessing }"
        @mousedown="startRecording"
        @mouseup="stopRecording"
        @touchstart.prevent="startRecording"
        @touchend.prevent="stopRecording"
      >
        <span class="mic-icon">{{ inCallMode ? '🎤' : '🎙️' }}</span>
        <span class="hold-tip">{{ getVoiceButtonText() }}</span>
      </button>
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
      isTyping: false,
      isRecording: false,
      isProcessing: false,
      recordingDuration: 0,
      recordingTimer: null,
      mediaRecorder: null,
      audioChunks: [],
      analyser: null,
      audioContext: null,
      textInput: '',
      messages: [],
      userId: 'user_' + Math.random().toString(36).substr(2, 9),
      serverUrl: 'ws://154.89.149.198:8765/ws',
      token: 'voice_9527_secret_key_2026',
      
      // Call mode
      inCallMode: false,
      callStatus: '等待...',
      vadThreshold: 0.01,
      vadSilenceThreshold: 1500, // ms of silence to detect end of speech
      lastSpeechTime: 0,
      vadInterval: null,
      stream: null
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
      console.log('Connecting to', this.serverUrl)
      this.ws = new WebSocket(this.serverUrl)

      this.ws.onopen = () => {
        console.log('WS Connected')
        this.isConnected = true
        this.send({
          action: 'auth',
          payload: { userId: this.userId, token: this.token }
        })
      }

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)
          console.log('WS Received:', data)
          this.handleMessage(data)
        } catch (e) {
          console.error('Parse error:', e)
        }
      }

      this.ws.onclose = () => {
        console.log('WS Disconnected')
        this.isConnected = false
        setTimeout(() => this.connectWebSocket(), 3000)
      }

      this.ws.onerror = (err) => {
        console.error('WS Error:', err)
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
          console.log('Auth OK:', payload)
          break

        case 'auth_fail':
          console.error('Auth failed:', payload)
          break

        case 'typing':
          this.isTyping = true
          this.callStatus = 'AI 处理中...'
          break

        case 'asr_result':
          // Show user speech
          this.messages.push({ role: 'user', text: payload.text })
          this.scrollToBottom()
          break

        case 'reply':
          this.isTyping = false
          this.messages.push({
            role: 'ai',
            text: payload.text,
            audioUrl: payload.audioUrl
          })
          this.scrollToBottom()
          
          // Auto-play audio
          if (payload.audioUrl) {
            this.callStatus = '播放语音...'
            this.playAudio(payload.audioUrl)
          } else {
            this.callStatus = '等待...'
          }
          break

        case 'error':
          this.isTyping = false
          this.callStatus = '出错: ' + payload.message
          setTimeout(() => {
            if (this.inCallMode) this.callStatus = '等待...'
          }, 3000)
          break
      }
    },

    // ===== Call Mode =====
    toggleCallMode() {
      if (this.inCallMode) {
        this.leaveCallMode()
      } else {
        this.enterCallMode()
      }
    },

    async enterCallMode() {
      try {
        // Request microphone permission
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        
        // Setup audio context for VAD
        this.audioContext = new (window.AudioContext || window.webkitAudioContext)()
        const source = this.audioContext.createMediaStreamSource(this.stream)
        this.analyser = this.audioContext.createAnalyser()
        this.analyser.fftSize = 256
        source.connect(this.analyser)
        
        this.inCallMode = true
        this.callStatus = '等待说话...'
        this.messages = []
        
        // Start VAD detection
        this.startVAD()
        
      } catch (e) {
        console.error('Failed to enter call mode:', e)
        alert('无法访问麦克风，请检查权限')
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
      
      this.callStatus = ''
    },

    // ===== VAD (Voice Activity Detection) =====
    startVAD() {
      const dataArray = new Uint8Array(this.analyser.frequencyBinCount)
      
      this.vadInterval = setInterval(() => {
        if (this.isRecording || this.isProcessing) return
        
        this.analyser.getByteFrequencyData(dataArray)
        
        // Calculate average volume
        const average = dataArray.reduce((a, b) => a + b) / dataArray.length
        const volume = average / 255
        
        const now = Date.now()
        
        if (volume > this.vadThreshold) {
          // Voice detected
          this.lastSpeechTime = now
          this.callStatus = '正在说话...'
          
          // Auto-start recording if not already
          if (!this.isRecording) {
            this.startRecording()
          }
        } else {
          // Silence
          if (this.isRecording && (now - this.lastSpeechTime) > this.vadSilenceThreshold) {
            // End of speech detected
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
    async startRecording() {
      if (this.isRecording || this.isProcessing) return
      
      try {
        if (!this.stream) {
          this.stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        }
        
        this.mediaRecorder = new MediaRecorder(this.stream)
        this.audioChunks = []

        this.mediaRecorder.ondataavailable = (e) => {
          if (e.data.size > 0) {
            this.audioChunks.push(e.data)
          }
        }

        this.mediaRecorder.onstop = () => {
          this.sendAudio()
        }

        this.mediaRecorder.start()
        this.isRecording = true
        this.recordingDuration = 0
        
        this.recordingTimer = setInterval(() => {
          this.recordingDuration++
        }, 1000)

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
      clearInterval(this.recordingTimer)
      this.recordingTimer = null
    },

    async sendAudio() {
      if (this.audioChunks.length === 0) return

      this.isProcessing = true
      this.callStatus = '识别中...'
      
      // Convert to base64
      const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm' })
      const reader = new FileReader()
      
      reader.onload = () => {
        const base64 = reader.result.split(',')[1]
        
        this.send({
          action: 'audio',
          payload: {
            userId: this.userId,
            data: base64,
            format: 'webm'
          }
        })
        
        // Show pending
        this.messages.push({ role: 'user', text: '🎤 正在识别...' })
        this.scrollToBottom()
        
        // Reset for next recording
        this.audioChunks = []
        this.isProcessing = false
      }
      
      reader.readAsDataURL(audioBlob)
    },

    // ===== Audio Playback =====
    playAudio(url) {
      const audio = new Audio(url)
      
      audio.onended = () => {
        console.log('Audio playback ended')
        if (this.inCallMode) {
          this.callStatus = '等待...'
        }
      }
      
      audio.onerror = (e) => {
        console.error('Audio playback error:', e)
        if (this.inCallMode) {
          this.callStatus = '播放出错'
          setTimeout(() => {
            if (this.inCallMode) this.callStatus = '等待...'
          }, 2000)
        }
      }
      
      audio.play().catch(e => {
        console.error('Play failed:', e)
      })
    },

    // ===== Text Message =====
    sendText() {
      const text = this.textInput.trim()
      if (!text) return

      this.send({
        action: 'msg',
        payload: { userId: this.userId, text }
      })

      this.messages.push({ role: 'user', text })
      this.textInput = ''
      this.scrollToBottom()
    },

    // ===== UI Helpers =====
    scrollToBottom() {
      this.$nextTick(() => {
        const chatArea = this.$refs.chatArea
        if (chatArea) {
          chatArea.scrollTop = chatArea.scrollHeight
        }
      })
    },

    getVoiceButtonText() {
      if (this.isProcessing) return '处理中'
      if (this.isRecording) return '识别中...'
      if (this.inCallMode) return '说话中'
      return '按住说话'
    },

    formatDuration(seconds) {
      const mins = Math.floor(seconds / 60)
      const secs = seconds % 60
      return `${mins}:${secs.toString().padStart(2, '0')}`
    }
  }
}
</script>

<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { 
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: #f5f5f5;
  height: 100vh;
  overflow: hidden;
}
.app { height: 100%; display: flex; flex-direction: column; }

/* Status Bar */
.status-bar {
  background: #fff;
  padding: 10px 15px;
  border-bottom: 1px solid #e0e0e0;
  display: flex;
  justify-content: center;
}
.status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #999;
}
.status.connected { color: #34c759; }
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #999;
}
.status.connected .dot { background: #34c759; }

/* Chat Area */
.chat-area {
  flex: 1;
  overflow-y: auto;
  padding: 15px;
  padding-bottom: 100px;
}
.empty-tip {
  text-align: center;
  padding-top: 100px;
  color: #999;
}
.empty-tip .sub { font-size: 12px; margin-top: 8px; }

/* Messages */
.message {
  display: flex;
  margin-bottom: 15px;
}
.message.user { justify-content: flex-end; }
.message.ai { justify-content: flex-start; }
.bubble {
  max-width: 75%;
  padding: 10px 14px;
  border-radius: 18px;
  font-size: 15px;
  line-height: 1.4;
}
.user .bubble {
  background: #007AFF;
  color: #fff;
  border-bottom-right-radius: 4px;
}
.ai .bubble {
  background: #fff;
  color: #333;
  border-bottom-left-radius: 4px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.1);
}

/* Typing */
.typing {
  display: flex;
  gap: 4px;
  padding: 10px 14px;
  background: #fff;
  border-radius: 18px;
  border-bottom-left-radius: 4px;
  width: fit-content;
  box-shadow: 0 1px 3px rgba(0,0,0,0.1);
}
.typing .dot {
  width: 6px;
  height: 6px;
  background: #999;
  animation: typing 1.4s infinite;
}
.typing .dot:nth-child(2) { animation-delay: 0.2s; }
.typing .dot:nth-child(3) { animation-delay: 0.4s; }
@keyframes typing {
  0%, 60%, 100% { transform: translateY(0); }
  30% { transform: translateY(-4px); }
}

/* Call Indicator */
.call-indicator {
  position: fixed;
  top: 50px;
  left: 50%;
  transform: translateX(-50%);
  background: #34c759;
  color: #fff;
  padding: 8px 20px;
  border-radius: 20px;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  box-shadow: 0 2px 8px rgba(52, 199, 89, 0.3);
  z-index: 100;
}
.call-pulse {
  width: 10px;
  height: 10px;
  background: #fff;
  border-radius: 50%;
  animation: pulse 1s infinite;
}
.call-status {
  font-size: 12px;
  opacity: 0.8;
}
@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.5; transform: scale(1.2); }
}

/* Input Area */
.input-area {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  background: #fff;
  padding: 12px 15px;
  padding-bottom: calc(12px + env(safe-area-inset-bottom));
  display: flex;
  align-items: center;
  gap: 10px;
  border-top: 1px solid #e0e0e0;
}
.input-area input {
  flex: 1;
  height: 40px;
  border: none;
  background: #f0f0f0;
  border-radius: 20px;
  padding: 0 16px;
  font-size: 15px;
  outline: none;
}
.send-btn {
  height: 36px;
  padding: 0 16px;
  background: #007AFF;
  color: #fff;
  border: none;
  border-radius: 18px;
  font-size: 14px;
  cursor: pointer;
}
.send-btn:disabled { background: #ccc; }

/* Call Button */
.call-btn {
  width: 44px;
  height: 44px;
  border: none;
  background: #f0f0f0;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.call-btn.active {
  background: #34c759;
  animation: call-pulse 2s infinite;
}
.call-btn .phone-icon { font-size: 20px; }
@keyframes call-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(52, 199, 89, 0.4); }
  50% { box-shadow: 0 0 0 10px rgba(52, 199, 89, 0); }
}

/* Voice Button */
.voice-btn {
  flex: 1;
  height: 50px;
  border: none;
  background: #007AFF;
  border-radius: 25px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.2s;
}
.voice-btn.recording {
  background: #ff3b30;
  animation: recording-pulse 1s infinite;
}
.voice-btn.listening {
  background: #34c759;
}
.mic-icon { font-size: 20px; }
.hold-tip {
  font-size: 11px;
  color: rgba(255,255,255,0.8);
}
@keyframes recording-pulse {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.05); }
}
</style>
