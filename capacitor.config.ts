import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.humanmessenger.app',
  appName: 'human-messenger',
  webDir: 'public',
  server: {
    url: 'http://192.168.0.101',
    cleartext: true
  }
};

export default config;
