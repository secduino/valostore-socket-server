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

    // Kullanıcı arama
    socket.on("search_user", async ({ gameName, tagLine }) => {
      const users = db.collection("users");
      const user = await users.findOne({ gameName, tagLine });

      if (user) {
        socket.emit("search_user_result", { gameName, tagLine });
      } else {
        socket.emit("search_user_result", { notFound: true });
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

      const userIds = result.map((f) =>
        f.from === userId ? f.to : f.from
      );

      const users = await db.collection("users").find({
        $or: userIds.map((id) => {
          const [gameName, tagLine] = id.split("#");
          return { gameName, tagLine };
        })
      }).toArray();

      socket.emit("friend_list", users);
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

    // Mesajları çekme
    socket.on("get_messages", async ({ from, to }) => {
      const messages = db.collection("messages");

      const result = await messages.find({
        $or: [
          { from, to },
          { from: to, to: from }
        ]
      }).sort({ timestamp: 1 }).toArray();

      socket.emit("message_history", result);
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
