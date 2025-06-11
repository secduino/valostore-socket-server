const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { MongoClient } = require("mongodb");
const cors = require("cors");

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// MongoDB bağlantısı
const uri = "mongodb+srv://valostoremobile:7gv2texdfgcyV3DG@cluster0.egxyjsw.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0";
const client = new MongoClient(uri);
let db;

async function startServer() {
  await client.connect();
  db = client.db("valostore");

  console.log("🟢 MongoDB bağlantısı başarılı");

  io.on("connection", (socket) => {
    console.log("🔌 Yeni kullanıcı bağlandı:", socket.id);

    // Kullanıcı kaydı
    socket.on("register_user", async ({ gameName, tagLine }) => {
      const users = db.collection("users");
      const existing = await users.findOne({ gameName, tagLine });

      if (!existing) {
        await users.insertOne({ gameName, tagLine });
        console.log(`🧍 Yeni kullanıcı: ${gameName}#${tagLine}`);
      }
    });

    // Arkadaş ekleme
    socket.on("add_friend", async ({ from, to }) => {
      const friends = db.collection("friends");
      await friends.insertOne({
        from,
        to,
        status: "pending"
      });
    });

    // Arkadaş listesini çek
    socket.on("get_friends", async ({ userId }) => {
      const friendsCol = db.collection("friends");

      const result = await friendsCol.find({
        $or: [
          { from: userId },
          { to: userId }
        ],
        status: "accepted"
      }).toArray();

      socket.emit("friend_list", result);
    });

    // Mesaj gönderme
    socket.on("send_message", async (data) => {
      const messages = db.collection("messages");
      const { from, to, message } = data;

      const msg = {
        from,
        to,
        message,
        timestamp: new Date(),
        isRead: false
      };

      await messages.insertOne(msg);
      io.emit("receive_message", msg);
    });

    // Okundu işaretleme
    socket.on("read_messages", async ({ from, to }) => {
      const messages = db.collection("messages");
      await messages.updateMany(
        { from, to, isRead: false },
        { $set: { isRead: true } }
      );
    });

    socket.on("disconnect", () => {
      console.log("⛔ Bağlantı kesildi:", socket.id);
    });
  });

  server.listen(10000, () => {
    console.log("🚀 Sunucu çalışıyor: 10000");
  });
}

startServer().catch(console.error);
