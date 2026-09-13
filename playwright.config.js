// 容器内无 root，Chromium 系统库解压在本目录，需注入 LD_LIBRARY_PATH
process.env.LD_LIBRARY_PATH = [
  '/tmp/chromelibs/root/usr/lib/aarch64-linux-gnu',
  '/tmp/chromelibs/root/lib/aarch64-linux-gnu',
  process.env.LD_LIBRARY_PATH || '',
].filter(Boolean).join(':');

module.exports = {
  testDir: './tests',
  timeout: 30000,
  retries: 0,
  use: {
    baseURL: 'http://127.0.0.1:8123',
    headless: true,
  },
  webServer: {
    command: 'python3 -m http.server 8123 --bind 127.0.0.1',
    url: 'http://127.0.0.1:8123/index.html',
    reuseExistingServer: true,
    timeout: 15000,
  },
};
