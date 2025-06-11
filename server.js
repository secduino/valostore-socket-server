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
    methods: ["GET", "POST"],
  },
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

    // ✅ Kullanıcı kaydı
    socket.on("register_user", async ({ gameName, tagLine }) => {
      const users = db.collection("users");
      const existing = await users.findOne({ gameName, tagLine });
      if (!existing) {
        await users.insertOne({ gameName, tagLine });
        console.log(`🧍 Yeni kullanıcı: ${gameName}#${tagLine}`);
      }
    });

    // ✅ Kullanıcı arama
    socket.on("search_user", async ({ gameName, tagLine }) => {
      console.log(`🔍 Arama: ${gameName}#${tagLine}`);
      const users = db.collection("users");
      const result = await users.findOne({ gameName, tagLine });

      if (result) {
        console.log("✅ Kullanıcı bulundu");
        socket.emit("search_results", [result]);
      } else {
        console.log("❌ Kullanıcı bulunamadı");
        socket.emit("search_results", []);
      }
    });

    // ✅ Arkadaş ekleme
    socket.on("add_friend", async ({ from, to }) => {
      const friends = db.collection("friends");
      const existing = await friends.findOne({ from, to });
      if (!existing) {
        await friends.insertOne({ from, to, status: "pending" });
        console.log(`👥 İstek gönderildi: ${from} ➡ ${to}`);
      }
    });

    // ✅ Arkadaş isteği kabul
    socket.on("accept_friend", async ({ from, to }) => {
      const friends = db.collection("friends");

      await friends.updateOne(
        { from, to, status: "pending" },
        { $set: { status: "accepted" } }
      );

      await friends.insertOne({ from: to, to: from, status: "accepted" });

      console.log(`🤝 Arkadaşlık kabul edildi: ${from} ⇆ ${to}`);
    });

    // ✅ Engelleme
    socket.on("block_friend", async ({ from, to }) => {
      const friends = db.collection("friends");
      await friends.updateOne(
        { from, to },
        { $set: { status: "blocked" } },
        { upsert: true }
      );
      console.log(`⛔ ${from} kullanıcısını engelledi: ${to}`);
    });

    // ✅ Arkadaş listesi
    socket.on("get_friends", async ({ userId }) => {
      const friends = db.collection("friends");
      const relations = await friends.find({
        $or: [{ from: userId }, { to: userId }]
      }).toArray();

      const userList = relations.map((rel) =>
        rel.from === userId ? rel.to : rel.from
      );

      const users = db.collection("users");
      const friendProfiles = await users.find({
        $or: userList.map((id) => {
          const [gameName, tagLine] = id.split("#");
          return { gameName, tagLine };
        }),
      }).toArray();

      const enrichedList = relations.map((rel) => {
        const friendId = rel.from === userId ? rel.to : rel.from;
        const [g, t] = friendId.split("#");

        const profile = friendProfiles.find(
          (p) => p.gameName === g && p.tagLine === t
        );

        return {
          gameName: g,
          tagLine: t,
          status: rel.status,
          direction: rel.from === userId ? "sent" : "received",
          avatar: profile?.avatar ?? null
        };
      });

      socket.emit("friend_list", enrichedList);
      console.log(`📦 Arkadaş listesi gönderildi: ${userId}`);
    });

    // ✅ Mesaj gönderme
    socket.on("send_message", async (data) => {
      const messages = db.collection("messages");
      const { from, to, message } = data;

      const msg = {
        from,
        to,
        message,
        timestamp: new Date(),
        isRead: false,
      };

      await messages.insertOne(msg);
      io.emit("receive_message", msg);
      console.log(`📨 Mesaj: ${from} → ${to}: ${message}`);
    });

    // ✅ Mesaj geçmişi
    socket.on("get_messages", async ({ from, to }) => {
      const messages = db.collection("messages");

      const result = await messages
        .find({
          $or: [
            { from, to },
            { from: to, to: from },
          ],
        })
        .sort({ timestamp: 1 })
        .toArray();

      socket.emit("chat_messages", result);
      console.log(`📚 Geçmiş mesajlar gönderildi: ${from} ⇄ ${to}`);
    });

    // ✅ Okundu bilgisi
    socket.on("read_messages", async ({ from, to }) => {
      const messages = db.collection("messages");
      await messages.updateMany(
        { from, to, isRead: false },
        { $set: { isRead: true } }
      );
      console.log(`📘 Okundu işaretlendi: ${from} → ${to}`);
    });

    socket.on("disconnect", () => {
      console.log("⛔ Bağlantı kesildi:", socket.id);
    });
  });
}

// ✅ Sunucuyu başlat
startServer().catch(console.error);

// ✅ Render veya yerel ortam portu
const port = process.env.PORT || 10000;
server.listen(port, () => {
  console.log(`🚀 Sunucu çalışıyor: ${port}`);
});

socket.on("get_friends", async ({ userId }) => {
  const friends = db.collection("friends");

  const relations = await friends.find({
    $or: [{ from: userId }, { to: userId }]
  }).toArray();

  const userList = relations.map((rel) =>
    rel.from === userId ? rel.to : rel.from
  );

  if (userList.length === 0) {
    socket.emit("friend_list", []);
    console.log(`📦 Boş arkadaş listesi gönderildi: ${userId}`);
    return;
  }

  const users = db.collection("users");

  const friendProfiles = await users.find({
    $or: userList.map((id) => {
      const [gameName, tagLine] = id.split("#");
      return { gameName, tagLine };
    }),
  }).toArray();

  const enrichedList = relations.map((rel) => {
    const friendId = rel.from === userId ? rel.to : rel.from;
    const [g, t] = friendId.split("#");

    const profile = friendProfiles.find(
      (p) => p.gameName === g && p.tagLine === t
    );

    return {
      gameName: g,
      tagLine: t,
      status: rel.status,
      direction: rel.from === userId ? "sent" : "received",
      avatar: profile?.avatar ?? null
    };
  });

  socket.emit("friend_list", enrichedList);
  console.log(`📦 Arkadaş listesi gönderildi: ${userId}`);
});
