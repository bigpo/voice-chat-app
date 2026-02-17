import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.voice.chat',
  appName: '语音助手',
  webDir: 'dist',
  android: {
    allowMixedContent: true,
    permissions: [
      'RECORD_AUDIO',
      'MODIFY_AUDIO_SETTINGS',
      'READ_PHONE_STATE',
      'INTERNET',
      'ACCESS_NETWORK_STATE',
      'WAKE_LOCK',
      'VIBRATE'
    ]
  }
};

export default config;
