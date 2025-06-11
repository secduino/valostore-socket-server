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

    // Arkadaş arama
socket.on("search_user", async ({ query }) => {
  const users = db.collection("users");

  // 🔥 Örnek: query = "karakterinisage#0000"
  const [gameName, tagLine] = query.split("#");

  if (!gameName || !tagLine) {
    socket.emit("search_results", []);
    return;
  }

  const result = await users.findOne({ gameName, tagLine });

  if (result) {
    socket.emit("search_results", [result]); // liste içinde döndür
  } else {
    socket.emit("search_results", []); // bulunamadı
  }
});

    // Arkadaş ekleme
    socket.on("add_friend", async ({ from, to }) => {
      const friends = db.collection("friends");
      const existing = await friends.findOne({ from, to });
      if (!existing) {
        await friends.insertOne({ from, to, status: "pending" });
        console.log(`👥 İstek gönderildi: ${from} ➡ ${to}`);
      }
    });

    // Arkadaş isteği kabul etme
    socket.on("accept_friend", async ({ from, to }) => {
      const friends = db.collection("friends");
      await friends.updateOne(
        { from, to, status: "pending" },
        { $set: { status: "accepted" } }
      );
      await friends.insertOne({ from: to, to: from, status: "accepted" });
    });

    // Engelleme
    socket.on("block_friend", async ({ from, to }) => {
      const friends = db.collection("friends");
      await friends.updateOne(
        { from, to },
        { $set: { status: "blocked" } },
        { upsert: true }
      );
    });

socket.on("get_friends", async ({ userId }) => {
  const friends = db.collection("friends");
  const result = await friends.find({
    $or: [{ from: userId }, { to: userId }],
    status: "accepted"
  }).toArray();

  const userList = result.map((f) =>
    f.from === userId ? f.to : f.from
  );

  if (userList.length === 0) {
    socket.emit("friend_list", []);
    return;
  }

  const users = db.collection("users");
  const friendsData = await users
    .find({
      $or: userList.map((id) => {
        const [gameName, tagLine] = id.split("#");
        return { gameName, tagLine };
      }),
    })
    .toArray();

  socket.emit("friend_list", friendsData);
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

    // Mesajları getirme
    socket.on("get_messages", async ({ from, to }) => {
      const messages = db.collection("messages");

      const result = await messages.find({
        $or: [
          { from, to },
          { from: to, to: from }
        ]
      }).sort({ timestamp: 1 }).toArray();

      socket.emit("chat_messages", result);
    });

    // Okundu bilgisi
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
