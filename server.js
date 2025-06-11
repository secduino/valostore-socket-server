const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { MongoClient } = require("mongodb");
const cors = require("cors");

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
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
      const users = db.collection("users");
      const existing = await users.findOne({ gameName, tagLine });
      if (!existing) {
        await users.insertOne({ gameName, tagLine });
        console.log(`🧍 Yeni kullanıcı: ${gameName}#${tagLine}`);
      }
    });

    socket.on("add_friend", async ({ from, to }) => {
      const friends = db.collection("friends");
      const existing = await friends.findOne({ from, to });
      if (!existing) {
        await friends.insertOne({ from, to, status: "pending" });
      }
    });

    socket.on("accept_friend", async ({ from, to }) => {
      const friends = db.collection("friends");
      await friends.updateOne({ from, to }, { $set: { status: "accepted" } });
    });

    socket.on("reject_friend", async ({ from, to }) => {
      const friends = db.collection("friends");
      await friends.deleteOne({ from, to });
    });

    socket.on("block_user", async ({ from, to }) => {
      const blocks = db.collection("blocks");
      const existing = await blocks.findOne({ from, to });
      if (!existing) {
        await blocks.insertOne({ from, to });
      }
    });

    socket.on("get_friends", async ({ userId }) => {
      const friends = db.collection("friends");
      const users = db.collection("users");

      const list = await friends.find({
        $or: [{ from: userId }, { to: userId }],
        status: "accepted"
      }).toArray();

      const friendProfiles = await Promise.all(
        list.map(async (f) => {
          const friendId = f.from === userId ? f.to : f.from;
          const [gameName, tagLine] = friendId.split("#");
          return await users.findOne({ gameName, tagLine });
        })
      );

      socket.emit("friend_list", friendProfiles);
    });

    socket.on("send_message", async ({ from, to, message }) => {
      const messages = db.collection("messages");

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

    socket.on("get_messages", async ({ from, to }) => {
      const messages = db.collection("messages");

      const history = await messages.find({
        $or: [
          { from, to },
          { from: to, to: from }
        ]
      }).sort({ timestamp: 1 }).toArray();

      socket.emit("message_history", history);
    });

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
