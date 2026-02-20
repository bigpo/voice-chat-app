<template>
  <div class="app">
    <div class="container">
      <h1>🎙️ 语音助手</h1>
      
      <!-- Voice Button -->
      <button 
        class="voice-button" 
        :class="{ listening: isListening }"
        @mousedown="!continuousMode && startRecording()"
        @mouseup="!continuousMode && stopRecording()"
        @touchstart.prevent="!continuousMode && startRecording()"
        @touchend.prevent="!continuousMode && stopRecording()"
        @click="continuousMode && onVoiceButtonClick()"
      >
        {{ isListening ? '正在听...' : (continuousMode ? '点击开始' : '按住说话') }}
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
        <div class="key-row">
          <input
            v-model="voiceApiKey"
            type="password"
            placeholder="输入 Voice API Key (ocv_...)"
          />
          <button @click="saveVoiceApiKey">保存Key</button>
        </div>
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
      
      // Phase flags
      useAppVad: true,
      useAppAsr: true,
      useAppTts: true,
      sendClientVadEvents: true,

      // App ASR (Qwen)
      asrApiKey: '',
      asrLanguage: 'zh',
      ttsVoice: 'Cherry',
      voiceApiKey: '',
      recordedAudioChunks: [],

      // Turn/telemetry
      currentTurnId: null,
      audioSeq: 0,
      recordStartAt: 0,
      lastSpeechAt: 0,
      hasSpeechInTurn: false,
      dynamicNoiseFloor: 0.003,
      silenceThresholdMs: 1000,
      maxRecordMs: 12000,

      // Config
      serverUrl: 'ws://154.89.149.198:8765/ws'
    }
  },
  mounted() {
    this.loadRuntimeConfig()
    this.connectWebSocket()
  },
  beforeUnmount() {
    this.disconnect()
  },
  methods: {
    loadRuntimeConfig() {
      const qs = new URLSearchParams(window.location.search)
      const toBool = (v, d) => {
        if (v === null || v === undefined || v === '') return d
        return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase())
      }

      this.useAppVad = toBool(qs.get('use_app_vad'), this.useAppVad)
      this.useAppAsr = toBool(qs.get('use_app_asr'), this.useAppAsr)
      this.useAppTts = toBool(qs.get('use_app_tts'), this.useAppTts)
      this.sendClientVadEvents = toBool(qs.get('send_client_vad_events'), this.sendClientVadEvents)

      const envKey = (import.meta && import.meta.env && import.meta.env.VITE_DASHSCOPE_API_KEY) || ''
      const queryKey = qs.get('dashscope_api_key') || ''
      const savedKey = localStorage.getItem('dashscope_api_key') || ''
      this.asrApiKey = queryKey || envKey || savedKey
      if (queryKey) localStorage.setItem('dashscope_api_key', queryKey)

      const envVoiceKey = (import.meta && import.meta.env && import.meta.env.VITE_OPENCLAW_VOICE_API_KEY) || ''
      const queryVoiceKey = qs.get('voice_api_key') || ''
      const savedVoiceKey = localStorage.getItem('voice_api_key') || ''
      this.voiceApiKey = queryVoiceKey || envVoiceKey || savedVoiceKey
      if (queryVoiceKey) localStorage.setItem('voice_api_key', queryVoiceKey)

      if (this.useAppAsr && !this.asrApiKey) {
        console.warn('App ASR disabled: missing DASHSCOPE API key')
        this.useAppAsr = false
      }
    },

    genTurnId() {
      if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID()
      return `turn_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
    },

    onVoiceButtonClick() {
      if (this.isListening) {
        this.stopRecording()
      } else {
        this.startRecording()
      }
    },

    connectWebSocket() {
      this.statusText = '连接中...'

      let wsUrl = this.serverUrl
      if (this.voiceApiKey) {
        const sep = wsUrl.includes('?') ? '&' : '?'
        wsUrl = `${wsUrl}${sep}api_key=${encodeURIComponent(this.voiceApiKey)}`
      }

      this.ws = new WebSocket(wsUrl)
      
      this.ws.onopen = () => {
        console.log('WS Connected')
        this.isConnected = true
        this.statusText = this.useAppVad ? '就绪（App VAD）' : '就绪（Server VAD）'
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

      this.ws.onclose = (ev) => {
        console.log('WS Disconnected', ev.code, ev.reason)
        this.isConnected = false
        if (ev.code === 4001 || ev.code === 4002) {
          this.statusText = '鉴权失败，请检查 Voice API Key'
          return
        }
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
          this.statusText = this.useAppTts ? '生成语音中...' : '说话中...'
          break
          
        case 'audio_chunk':
          if (!this.useAppTts) {
            this.playAudioChunk(data.data, data.sample_rate || 16000)
          }
          break
          
        case 'response_complete':
          this.handleResponseComplete(data)
          break
      }
    },

    async handleResponseComplete(data) {
      const spokenText = (data?.spoken_text || data?.text || '').trim()

      if (this.useAppTts && spokenText) {
        this.statusText = '说话中...'
        try {
          const audioUrl = await this.synthesizeWithQwenTts(spokenText)
          if (audioUrl) {
            await this.playRemoteAudio(audioUrl)
          }
        } catch (e) {
          console.error('App TTS failed:', e)
        }
      }

      this.isProcessing = false
      this.currentTurnId = null
      this.statusText = this.continuousMode ? '🎙️ 就绪' : '就绪'
      if (this.continuousMode) {
        setTimeout(() => this.startRecording(), 500)
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

        this.currentTurnId = this.genTurnId()
        this.audioSeq = 0
        this.recordStartAt = Date.now()
        this.lastSpeechAt = this.recordStartAt
        this.hasSpeechInTurn = false
        this.recordedAudioChunks = []
        
        // Setup audio processing
        this.audioContext = new AudioContext({ sampleRate: 16000 })
        this.audioSource = this.audioContext.createMediaStreamSource(this.mediaStream)
        this.audioProcessor = this.audioContext.createScriptProcessor(4096, 1, 1)
        
        this.audioProcessor.onaudioprocess = (e) => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            const audioData = e.inputBuffer.getChannelData(0)
            this.recordedAudioChunks.push(new Float32Array(audioData))
            const base64 = this.float32ToBase64(audioData)
            this.ws.send(JSON.stringify({
              type: 'audio',
              data: base64,
              turn_id: this.currentTurnId,
              seq: this.audioSeq++,
              client_ts_ms: Date.now(),
            }))

            if (this.continuousMode && this.useAppVad) {
              const now = Date.now()
              let sqSum = 0
              for (let i = 0; i < audioData.length; i++) {
                const v = audioData[i]
                sqSum += v * v
              }
              const rms = Math.sqrt(sqSum / audioData.length)

              if (rms < this.dynamicNoiseFloor * 1.8) {
                this.dynamicNoiseFloor = this.dynamicNoiseFloor * 0.98 + rms * 0.02
              }

              const speechStartThreshold = Math.max(this.dynamicNoiseFloor * 3.0, 0.012)
              const speechEndThreshold = Math.max(this.dynamicNoiseFloor * 1.8, 0.006)

              if (rms > speechStartThreshold) {
                if (!this.hasSpeechInTurn && this.sendClientVadEvents) {
                  this.ws.send(JSON.stringify({
                    type: 'client_vad',
                    turn_id: this.currentTurnId,
                    event: 'speech_started',
                    rms,
                    threshold: speechStartThreshold,
                    ts_ms: now,
                  }))
                }
                this.hasSpeechInTurn = true
                this.lastSpeechAt = now
              }

              if (this.hasSpeechInTurn && rms < speechEndThreshold && (now - this.lastSpeechAt) > this.silenceThresholdMs) {
                if (this.sendClientVadEvents) {
                  this.ws.send(JSON.stringify({
                    type: 'client_vad',
                    turn_id: this.currentTurnId,
                    event: 'speech_stopped',
                    rms,
                    threshold: speechEndThreshold,
                    ts_ms: now,
                  }))
                }
                this.stopRecording()
                return
              }

              if ((now - this.recordStartAt) > this.maxRecordMs) {
                this.stopRecording()
                return
              }
            }
          }
        }
        
        this.audioSource.connect(this.audioProcessor)
        this.audioProcessor.connect(this.audioContext.destination)
        
        this.isListening = true
        this.transcript = ''
        this.aiResponse = ''
        
        this.ws.send(JSON.stringify({
          type: 'start_listening',
          turn_id: this.currentTurnId,
          client_features: { use_app_vad: this.useAppVad, use_app_asr: this.useAppAsr, use_app_tts: this.useAppTts },
        }))
        
      } catch (e) {
        console.error('Recording error:', e)
        alert('无法打开麦克风: ' + e.message)
      }
    },

    async stopRecording() {
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

      if (!(this.ws && this.ws.readyState === WebSocket.OPEN)) return

      this.isProcessing = true
      this.ws.send(JSON.stringify({
        type: 'stop_listening',
        turn_id: this.currentTurnId,
        skip_server_asr: this.useAppAsr,
        client_metrics: {
          app_vad: this.useAppVad,
          app_asr: this.useAppAsr,
          had_speech: this.hasSpeechInTurn,
          record_ms: Date.now() - this.recordStartAt,
        },
      }))

      if (this.useAppAsr) {
        this.statusText = 'ASR识别中...'
        const asrStartedAt = Date.now()
        let text = ''
        try {
          text = await this.transcribeWithQwen(this.recordedAudioChunks, 16000)
        } catch (e) {
          console.error('App ASR failed:', e)
          text = ''
        }

        const asrLatency = Date.now() - asrStartedAt
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({
            type: 'transcript_final',
            turn_id: this.currentTurnId,
            text,
            source: 'app_qwen_asr',
            latency_ms: { asr_client: asrLatency },
          }))
        }
      }
    },

    async transcribeWithQwen(chunks, sampleRate = 16000) {
      if (!this.asrApiKey) throw new Error('Missing DASHSCOPE API key for App ASR')
      if (!chunks || chunks.length === 0) return ''

      const pcm = this.mergeFloat32Chunks(chunks)
      const wavBytes = this.float32ToWavBytes(pcm, sampleRate)
      const b64 = this.uint8ToBase64(wavBytes)
      const dataUrl = `data:audio/wav;base64,${b64}`

      const resp = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.asrApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'qwen3-asr-flash',
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'input_audio',
                  input_audio: { data: dataUrl },
                },
              ],
            },
          ],
          extra_body: {
            asr_options: {
              language: this.asrLanguage,
            },
          },
          stream: false,
        }),
      })

      if (!resp.ok) {
        const txt = await resp.text()
        throw new Error(`Qwen ASR HTTP ${resp.status}: ${txt}`)
      }

      const json = await resp.json()
      return (json?.choices?.[0]?.message?.content || '').trim()
    },

    mergeFloat32Chunks(chunks) {
      const total = chunks.reduce((n, c) => n + c.length, 0)
      const out = new Float32Array(total)
      let offset = 0
      for (const c of chunks) {
        out.set(c, offset)
        offset += c.length
      }
      return out
    },

    float32ToWavBytes(float32Array, sampleRate = 16000) {
      const pcm16 = new Int16Array(float32Array.length)
      for (let i = 0; i < float32Array.length; i++) {
        const s = Math.max(-1, Math.min(1, float32Array[i]))
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
      }

      const dataSize = pcm16.length * 2
      const buffer = new ArrayBuffer(44 + dataSize)
      const view = new DataView(buffer)

      const writeString = (offset, str) => {
        for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i))
      }

      writeString(0, 'RIFF')
      view.setUint32(4, 36 + dataSize, true)
      writeString(8, 'WAVE')
      writeString(12, 'fmt ')
      view.setUint32(16, 16, true)
      view.setUint16(20, 1, true)
      view.setUint16(22, 1, true)
      view.setUint32(24, sampleRate, true)
      view.setUint32(28, sampleRate * 2, true)
      view.setUint16(32, 2, true)
      view.setUint16(34, 16, true)
      writeString(36, 'data')
      view.setUint32(40, dataSize, true)

      let offset = 44
      for (let i = 0; i < pcm16.length; i++, offset += 2) {
        view.setInt16(offset, pcm16[i], true)
      }

      return new Uint8Array(buffer)
    },

    uint8ToBase64(uint8) {
      let binary = ''
      const chunk = 0x8000
      for (let i = 0; i < uint8.length; i += chunk) {
        const slice = uint8.subarray(i, i + chunk)
        binary += String.fromCharCode(...slice)
      }
      return btoa(binary)
    },

    async synthesizeWithQwenTts(text) {
      if (!this.asrApiKey) throw new Error('Missing DASHSCOPE API key for App TTS')
      if (!text || !text.trim()) return ''

      const resp = await fetch('https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.asrApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'qwen3-tts-flash',
          input: {
            text: text.slice(0, 500),
            voice: this.ttsVoice,
            language_type: 'Chinese',
          },
        }),
      })

      if (!resp.ok) {
        const txt = await resp.text()
        throw new Error(`Qwen TTS HTTP ${resp.status}: ${txt}`)
      }

      const json = await resp.json()
      const rawUrl = json?.output?.audio?.url || ''
      if (!rawUrl) return ''
      return rawUrl.startsWith('http://') ? rawUrl.replace('http://', 'https://') : rawUrl
    },

    async playRemoteAudio(url) {
      return new Promise((resolve) => {
        try {
          const audio = new Audio(url)
          audio.onended = () => resolve()
          audio.onerror = () => resolve()
          const p = audio.play()
          if (p && typeof p.catch === 'function') {
            p.catch(() => resolve())
          }
        } catch (_) {
          resolve()
        }
      })
    },

    playAudioChunk(base64Data, sampleRate = 16000) {
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
        
        const audioCtx = new AudioContext({ sampleRate })
        const buffer = audioCtx.createBuffer(1, float32Array.length, sampleRate)
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

    saveVoiceApiKey() {
      const key = (this.voiceApiKey || '').trim()
      if (!key) {
        localStorage.removeItem('voice_api_key')
      } else {
        localStorage.setItem('voice_api_key', key)
      }

      if (this.ws) {
        this.ws.close()
      } else {
        this.connectWebSocket()
      }
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
  flex-direction: column;
  gap: 10px;
  justify-content: center;
  align-items: center;
}

.key-row {
  display: flex;
  width: 100%;
  max-width: 460px;
  gap: 8px;
}

.key-row input {
  flex: 1;
  padding: 10px 12px;
  border: 1px solid #444;
  border-radius: 8px;
  background: rgba(255,255,255,0.06);
  color: #fff;
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
