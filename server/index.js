// Azul 在线对战 - 服务入口
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const { router: authRouter } = require('./auth');
const rooms = require('./rooms');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use('/api/auth', authRouter);
app.use(express.static(path.join(__dirname, '..', 'public')));

// SPA 回退
app.get(/^\/(?!api|socket\.io).*/, (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

rooms.setup(io);

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`花砖物语 (Azul) 服务已启动: http://localhost:${PORT}`);
  // 打印局域网地址，方便朋友同一 WiFi 下加入对战
  const nets = require('os').networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`  局域网邀请地址（同一 WiFi 的朋友可访问）: http://${net.address}:${PORT}`);
      }
    }
  }
});
