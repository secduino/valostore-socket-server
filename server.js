const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { MongoClient } = require("mongodb");
const cors = require("cors");

const app = express();
app.use(cors());

app.get("/", (req, res) => {
  res.status(200).send("✅ Valstore socket server çalışıyor.");
});

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

    socket.on("register_user", async ({ gameName, tagLine }) => {
      const userId = `${gameName}#${tagLine}`;
      socket.userId = userId;

      const users = db.collection("users");
      const existing = await users.findOne({ gameName, tagLine });
      if (!existing) {
        await users.insertOne({ gameName, tagLine, status: "online" });
        console.log(`🧍 Yeni kullanıcı: ${userId}`);
      } else {
        await users.updateOne(
          { gameName, tagLine },
          { $set: { status: "online" } }
        );
      }

      console.log(`📍 Socket eşlendi: ${socket.id} → ${userId}`);

      const pending = await db.collection("friends").find({
        to: userId,
        status: "pending",
      }).toArray();

      pending.forEach((req) => {
        socket.emit("friend_request", { from: req.from, to: req.to });
        console.log(`📬 Offline isteği bildirildi → ${userId}`);
      });

      io.emit("user_status", { userId, status: "online" });
    });

    socket.on("search_user", async ({ gameName, tagLine }) => {
      console.log(`🔍 Arama: ${gameName}#${tagLine}`);
      const users = db.collection("users");
      const result = await users.findOne({ gameName, tagLine });
      socket.emit("search_results", result ? [result] : []);
    });

    socket.on("add_friend", async ({ from, to }) => {
      const friends = db.collection("friends");
      const existing = await friends.findOne({ from, to });
      if (!existing) {
        await friends.insertOne({ from, to, status: "pending" });
        console.log(`👥 İstek gönderildi: ${from} ➡ ${to}`);

        const toSocket = [...io.sockets.sockets.values()].find(
          (s) => s.userId === to
        );
        if (toSocket) {
          console.log(`🔔 Bildirim gönderiliyor → ${to}`);
          toSocket.emit("friend_request", { from, to });
        } else {
          console.log(`📭 Bildirim gönderilemedi, ${to} çevrimdışı`);
        }

        socket.emit("friend_request_status", {
          status: "pending",
          from,
          to,
        });
      }
    });

    socket.on("accept_friend", async ({ from, to }) => {
      const friends = db.collection("friends");
      const result = await friends.updateOne(
        { from, to, status: "pending" },
        { $set: { status: "accepted" } }
      );

      console.log(`✅ Arkadaşlık kabul edildi: ${from} ↔ ${to}`);

      if (result.modifiedCount === 1) {
        const sockets = [...io.sockets.sockets.values()];
        const fromSocket = sockets.find((s) => s.userId === from);
        const toSocket = sockets.find((s) => s.userId === to);

        if (fromSocket) fromSocket.emit("friend_list_request");
        if (toSocket) toSocket.emit("friend_list_request");
      }
    });

    socket.on("reject_friend", async ({ from, to }) => {
      const friends = db.collection("friends");
      await friends.deleteOne({ from, to, status: "pending" });
      console.log(`❌ Arkadaşlık reddedildi: ${from} ➡ ${to}`);

      const sockets = [...io.sockets.sockets.values()];
      const fromSocket = sockets.find((s) => s.userId === from);
      const toSocket = sockets.find((s) => s.userId === to);

      if (fromSocket) fromSocket.emit("friend_list_request");
      if (toSocket) toSocket.emit("friend_list_request");
    });

    socket.on("remove_friend", async ({ from, to }) => {
      const friends = db.collection("friends");
      await friends.deleteOne({
        $or: [
          { from, to, status: "accepted" },
          { from: to, to: from, status: "accepted" },
        ],
      });
      console.log(`🗑️ Arkadaş silindi: ${from} ↔ ${to}`);

      const sockets = [...io.sockets.sockets.values()];
      const fromSocket = sockets.find((s) => s.userId === from);
      const toSocket = sockets.find((s) => s.userId === to);

      if (fromSocket) fromSocket.emit("friend_list_request");
      if (toSocket) toSocket.emit("friend_list_request");
    });

    socket.on("block_friend", async ({ from, to }) => {
      const friends = db.collection("friends");
      await friends.updateOne(
        { from, to },
        { $set: { status: "blocked" } },
        { upsert: true }
      );
      await friends.deleteOne({
        $or: [
          { from, to, status: "accepted" },
          { from: to, to: from, status: "accepted" },
        ],
      });
      console.log(`⛔ Kullanıcı engellendi: ${from} ✋ ${to}`);

      const sockets = [...io.sockets.sockets.values()];
      const fromSocket = sockets.find((s) => s.userId === from);
      const toSocket = sockets.find((s) => s.userId === to);

      if (fromSocket) fromSocket.emit("friend_list_request");
      if (toSocket) toSocket.emit("friend_list_request");
    });

    socket.on("update_status", async ({ userId, status }) => {
      const [gameName, tagLine] = userId.split("#");
      const users = db.collection("users");
      await users.updateOne(
        { gameName, tagLine },
        { $set: { status } }
      );
      console.log(`🌐 Durum güncellendi: ${userId} -> ${status}`);
      io.emit("user_status", { userId, status });
    });

    socket.on("get_friends", async ({ userId }) => {
      const friends = db.collection("friends");
      const relations = await friends
        .find({
          $or: [{ from: userId }, { to: userId }],
          status: "accepted",
        })
        .toArray();

      if (!relations.length) {
        socket.emit("friend_list", []);
        return;
      }

      const userList = relations.map((rel) =>
        rel.from === userId ? rel.to : rel.from
      );

      const users = db.collection("users");
      const profiles = await users
        .find({
          $or: userList.map((id) => {
            const [gameName, tagLine] = id.split("#");
            return { gameName, tagLine };
          }),
        })
        .toArray();

      const enriched = relations.map((rel) => {
        const friendId = rel.from === userId ? rel.to : rel.from;
        const [g, t] = friendId.split("#");
        const profile = profiles.find(
          (p) => p.gameName === g && p.tagLine === t
        );

        return {
          gameName: g,
          tagLine: t,
          status: profile?.status ?? "offline",
          direction: rel.from === userId ? "sent" : "received",
          avatar: profile?.avatar ?? null,
          from: rel.from,
          to: rel.to,
        };
      });

      socket.emit("friend_list", enriched);
    });

    socket.on("send_message", async ({ from, to, message }) => {
      const messages = db.collection("messages");
      const msg = {
        from,
        to,
        message,
        timestamp: new Date(),
        isRead: false,
      };
      await messages.insertOne(msg);
      console.log(`📨 Mesaj gönderildi: ${from} -> ${to}`);
      io.emit("receive_message", msg);
    });

    socket.on("get_messages", async ({ from, to }) => {
      const messages = db.collection("messages");
      const result = await messages
        .find({ $or: [{ from, to }, { from: to, to: from }] })
        .sort({ timestamp: 1 })
        .toArray();

      console.log(`📬 Mesajlar alındı: ${from} ↔ ${to}`);
      socket.emit("chat_messages", result);
    });

    socket.on("read_messages", async ({ from, to }) => {
      const messages = db.collection("messages");
      await messages.updateMany(
        { from, to, isRead: false },
        { $set: { isRead: true } }
      );
      console.log(`📘 Okundu: ${from} -> ${to}`);

      const updatedMessages = await messages
        .find({ $or: [{ from, to }, { from: to, to: from }] })
        .sort({ timestamp: 1 })
        .toArray();

      const sockets = [...io.sockets.sockets.values()];
      const fromSocket = sockets.find((s) => s.userId === from);
      const toSocket = sockets.find((s) => s.userId === to);

      if (fromSocket) fromSocket.emit("messages_updated", updatedMessages);
      if (toSocket) toSocket.emit("messages_updated", updatedMessages);
    });

    // ✅ DELETE_CHAT EVENTİ EKLENDİ
    socket.on("delete_chat", async ({ from, to }) => {
      const messages = db.collection("messages");
      const result = await messages.deleteMany({
        $or: [
          { from, to },
          { from: to, to: from }
        ]
      });
      console.log(`🗑️ Sohbet silindi: ${from} ↔ ${to} (${result.deletedCount} mesaj)`);
    });

    socket.on("disconnect", async () => {
      if (socket.userId) {
        const [gameName, tagLine] = socket.userId.split("#");
        const users = db.collection("users");
        await users.updateOne(
          { gameName, tagLine },
          { $set: { status: "offline" } }
        );
        io.emit("user_status", { userId: socket.userId, status: "offline" });
        console.log(`⛔ Bağlantı kesildi: ${socket.userId}`);
      }
    });
  });
}

const port = process.env.PORT || 10000;
server.listen(port, () => {
  console.log(`🚀 Sunucu çalışıyor: ${port}`);
});

startServer().catch(console.error);
