const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const app = express();

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
  }
});

io.on('connection', (socket) => {
  console.log('Kullanıcı bağlandı:', socket.id);

  socket.on('message', (data) => {
    console.log('Mesaj:', data);
    socket.broadcast.emit('message', data);
  });

  socket.on('disconnect', () => {
    console.log('Kullanıcı ayrıldı:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Sunucu çalışıyor: ${PORT}`);
});
