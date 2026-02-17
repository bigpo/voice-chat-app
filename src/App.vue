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
        <p>👋 长按麦克风说话</p>
        <p class="sub">松开发送语音</p>
      </div>
      
      <div
        v-for="(msg, index) in messages"
        :key="index"
        class="message"
        :class="{ 'user': msg.role === 'user', 'ai': msg.role === 'ai' }"
      >
        <div class="bubble">
          <p>{{ msg.text }}</p>
          <audio
            v-if="msg.audioUrl"
            :src="msg.audioUrl"
            controls
            @play="onAudioPlay(msg)"
          ></audio>
        </div>
      </div>

      <!-- Typing Indicator -->
      <div v-if="isTyping" class="typing">
        <span class="dot"></span>
        <span class="dot"></span>
        <span class="dot"></span>
      </div>
    </div>

    <!-- Recording Indicator -->
    <div v-if="isRecording" class="recording-indicator">
      <div class="recording-dot"></div>
      <span>{{ formatDuration(recordingDuration) }}</span>
    </div>

    <!-- Input Area -->
    <div class="input-area">
      <input
        v-model="textInput"
        type="text"
        placeholder="输入文字消息..."
        @keyup.enter="sendText"
      />
      <button class="send-btn" @click="sendText" :disabled="!textInput.trim()">
        发送
      </button>
      
      <!-- Voice Button -->
      <button
        class="voice-btn"
        :class="{ recording: isRecording }"
        @mousedown="startRecording"
        @mouseup="stopRecording"
        @touchstart.prevent="startRecording"
        @touchend.prevent="stopRecording"
      >
        <span class="mic-icon">🎤</span>
        <span class="hold-tip">{{ isRecording ? '松开发送' : '按住说话' }}</span>
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
      recordingDuration: 0,
      recordingTimer: null,
      mediaRecorder: null,
      audioChunks: [],
      textInput: '',
      messages: [],
      userId: 'user_' + Math.random().toString(36).substr(2, 9),
      serverUrl: 'ws://154.89.149.198:8765/ws',
      token: 'voice_9527_secret_key_2026'
    }
  },
  mounted() {
    this.connectWebSocket()
    
    // Request permissions
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      console.log('Audio recording available')
    }
  },
  beforeUnmount() {
    this.disconnectWebSocket()
  },
  methods: {
    connectWebSocket() {
      console.log('Connecting to', this.serverUrl)
      this.ws = new WebSocket(this.serverUrl)

      this.ws.onopen = () => {
        console.log('WS Connected')
        this.isConnected = true
        
        // Authenticate
        this.send({
          action: 'auth',
          payload: {
            userId: this.userId,
            token: this.token
          }
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
        // Reconnect after 3 seconds
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
          break

        case 'asr_result':
          // Show ASR result
          this.messages.push({
            role: 'user',
            text: payload.text,
            audioUrl: null
          })
          this.scrollToBottom()
          break

        case 'reply':
          this.isTyping = false
          this.messages.push({
            role: 'ai',
            text: payload.text,
            audioUrl: payload.audioUrl || null
          })
          this.scrollToBottom()
          
          // Auto-play audio if available
          if (payload.audioUrl) {
            // Audio will play when user clicks play button
          }
          break

        case 'error':
          this.isTyping = false
          alert('Error: ' + payload.message)
          break
      }
    },

    async startRecording() {
      if (this.isRecording) return
      
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        this.mediaRecorder = new MediaRecorder(stream)
        this.audioChunks = []

        this.mediaRecorder.ondataavailable = (e) => {
          if (e.data.size > 0) {
            this.audioChunks.push(e.data)
          }
        }

        this.mediaRecorder.onstop = () => {
          this.sendAudio()
          // Stop all tracks
          stream.getTracks().forEach(track => track.stop())
        }

        this.mediaRecorder.start()
        this.isRecording = true
        this.recordingDuration = 0
        
        this.recordingTimer = setInterval(() => {
          this.recordingDuration++
        }, 1000)

      } catch (e) {
        console.error('Recording error:', e)
        alert('无法访问麦克风，请检查权限')
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
        
        // Show pending message
        this.messages.push({
          role: 'user',
          text: '🎤 语音发送中...',
          audioUrl: null
        })
        this.scrollToBottom()
      }
      
      reader.readAsDataURL(audioBlob)
    },

    sendText() {
      const text = this.textInput.trim()
      if (!text) return

      this.send({
        action: 'msg',
        payload: {
          userId: this.userId,
          text: text
        }
      })

      this.messages.push({
        role: 'user',
        text: text,
        audioUrl: null
      })
      
      this.textInput = ''
      this.scrollToBottom()
    },

    onAudioPlay(msg) {
      console.log('Playing audio for:', msg.text)
    },

    scrollToBottom() {
      this.$nextTick(() => {
        const chatArea = this.$refs.chatArea
        if (chatArea) {
          chatArea.scrollTop = chatArea.scrollHeight
        }
      })
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
.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: #f5f5f5;
}

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

.status.connected {
  color: #34c759;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #999;
}

.status.connected .dot {
  background: #34c759;
}

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

.empty-tip .sub {
  font-size: 12px;
  margin-top: 8px;
}

/* Messages */
.message {
  display: flex;
  margin-bottom: 15px;
}

.message.user {
  justify-content: flex-end;
}

.message.ai {
  justify-content: flex-start;
}

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

.bubble audio {
  width: 100%;
  margin-top: 8px;
  height: 32px;
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

.typing .dot:nth-child(2) {
  animation-delay: 0.2s;
}

.typing .dot:nth-child(3) {
  animation-delay: 0.4s;
}

@keyframes typing {
  0%, 60%, 100% { transform: translateY(0); }
  30% { transform: translateY(-4px); }
}

/* Recording Indicator */
.recording-indicator {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  background: rgba(0,0,0,0.8);
  color: #fff;
  padding: 20px 30px;
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  z-index: 100;
}

.recording-dot {
  width: 20px;
  height: 20px;
  background: #ff3b30;
  border-radius: 50%;
  animation: pulse 1s infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
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

.send-btn:disabled {
  background: #ccc;
}

.voice-btn {
  height: 44px;
  width: 80px;
  border: none;
  background: #f0f0f0;
  border-radius: 22px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background 0.2s;
}

.voice-btn.recording {
  background: #ff3b30;
}

.mic-icon {
  font-size: 18px;
}

.hold-tip {
  font-size: 10px;
  color: #666;
}

.voice-btn.recording .hold-tip {
  color: #fff;
}
</style>
