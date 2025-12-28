require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { MongoClient, ObjectId } = require("mongodb");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.status(200).send("✅ Valostore socket server çalışıyor.");
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri);
let db;

// Yardımcı fonksiyon: Socket bul
function findSocketByUserId(userId) {
  return [...io.sockets.sockets.values()].find((s) => s.userId === userId);
}

// Yardımcı fonksiyon: Kullanıcı online mı?
async function isUserOnline(userId) {
  const socket = findSocketByUserId(userId);
  if (socket) return true;
  
  const [gameName, tagLine] = userId.split("#");
  const user = await db.collection("users").findOne({ gameName, tagLine });
  return user?.status === "online";
}

// Yardımcı fonksiyon: Arkadaş ID'lerini al
async function getFriendIds(userId) {
  const friends = db.collection("friends");
  const relations = await friends
    .find({
      $or: [{ from: userId }, { to: userId }],
      status: "accepted",
    })
    .toArray();
  
  return relations.map(rel => rel.from === userId ? rel.to : rel.from);
}

// ==================== YENİ: Status değişikliğini arkadaşlara bildir ====================
async function notifyFriendsOfStatusChange(userId, newStatus) {
  const friendIds = await getFriendIds(userId);
  
  console.log(`📢 Status değişikliği bildiriliyor: ${userId} → ${newStatus} (${friendIds.length} arkadaşa)`);
  
  friendIds.forEach(friendId => {
    const friendSocket = findSocketByUserId(friendId);
    if (friendSocket) {
      // Hem user_status hem friend_status_changed event'lerini gönder
      friendSocket.emit("user_status", { userId, status: newStatus });
      friendSocket.emit("friend_status_changed", { userId, status: newStatus });
      console.log(`  → ${friendId}'e bildirildi`);
    }
  });
}

async function startServer() {
  await client.connect();
  db = client.db("valostore");
  console.log("🟢 MongoDB bağlantısı başarılı");

  // Boş kayıtları temizle
  try {
    await db.collection("users").deleteMany({ 
      $or: [
        { gameName: "" },
        { gameName: null },
        { tagLine: "" },
        { tagLine: null }
      ]
    });
    console.log("🧹 Boş kullanıcı kayıtları temizlendi");
  } catch (err) {
    console.log("⚠️ Temizleme atlandı:", err.message);
  }

  // Index oluştur (performans için)
  try {
    await db.collection("users").createIndex({ gameName: 1, tagLine: 1 });
    console.log("📇 users index oluşturuldu");
  } catch (err) {
    console.log("⚠️ users index atlandı:", err.message);
  }

  try {
    await db.collection("friends").createIndex({ from: 1, to: 1 });
    await db.collection("friends").createIndex({ status: 1 });
    console.log("📇 friends index oluşturuldu");
  } catch (err) {
    console.log("⚠️ friends index atlandı:", err.message);
  }

  try {
    await db.collection("messages").createIndex({ from: 1, to: 1, timestamp: 1 });
    console.log("📇 messages index oluşturuldu");
  } catch (err) {
    console.log("⚠️ messages index atlandı:", err.message);
  }

  io.on("connection", (socket) => {
    console.log("🔌 Yeni kullanıcı bağlandı:", socket.id);

    // ==================== KULLANICI YÖNETİMİ ====================
    
    socket.on("register_user", async ({ gameName, tagLine }) => {
      const userId = `${gameName}#${tagLine}`;
      socket.userId = userId;
      const users = db.collection("users");
      
      // Upsert kullan - varsa güncelle, yoksa ekle
      const result = await users.updateOne(
        { gameName, tagLine },
        { 
          $set: { status: "online", lastSeen: new Date() },
          $setOnInsert: { 
            avatar: null,
            displayName: null,
            statusMessage: null,
            createdAt: new Date()
          }
        },
        { upsert: true }
      );

      console.log(`📍 Socket eşlendi: ${socket.id} → ${userId} (upserted: ${result.upsertedCount || 0})`);

      // Bekleyen arkadaşlık isteklerini gönder
      const pending = await db.collection("friends").find({
        to: userId,
        status: "pending",
      }).toArray();

      if (pending.length > 0) {
        socket.emit("pending_requests", pending.map(req => ({ from: req.from, to: req.to })));
        console.log(`📬 ${pending.length} bekleyen istek bildirildi → ${userId}`);
      }

      // Arkadaşlara online durumunu bildir
      await notifyFriendsOfStatusChange(userId, "online");
      
      // Genel yayın (tüm bağlı kullanıcılara)
      io.emit("user_status", { userId, status: "online" });
    });

    // ==================== KULLANICI ARAMA ====================
    
    socket.on("search_user", async ({ gameName, tagLine }) => {
      console.log(`🔍 Arama: ${gameName}#${tagLine}`);
      const users = db.collection("users");
      
      let result;
      if (tagLine) {
        result = await users.findOne({ gameName, tagLine });
        socket.emit("search_results", result ? [result] : []);
      } else {
        const results = await users.find({ 
          gameName: { $regex: gameName, $options: 'i' } 
        }).limit(10).toArray();
        socket.emit("search_results", results);
      }
    });

    // ==================== ARKADAŞLIK İSTEKLERİ ====================
    
    socket.on("add_friend", async ({ from, to }) => {
      const friends = db.collection("friends");
      
      if (from === to) {
        socket.emit("friend_request_status", { status: "error", message: "Cannot add yourself" });
        return;
      }

      const alreadyFriends = await friends.findOne({
        $or: [
          { from, to, status: "accepted" },
          { from: to, to: from, status: "accepted" }
        ]
      });
      
      if (alreadyFriends) {
        socket.emit("friend_request_status", { status: "already_friends", from, to });
        console.log(`⚠️ Zaten arkadaşlar: ${from} ↔ ${to}`);
        return;
      }

      const pendingRequest = await friends.findOne({
        $or: [
          { from, to, status: "pending" },
          { from: to, to: from, status: "pending" }
        ]
      });

      if (pendingRequest) {
        if (pendingRequest.from === to && pendingRequest.to === from) {
          await friends.updateOne(
            { from: to, to: from, status: "pending" },
            { $set: { status: "accepted" } }
          );
          
          socket.emit("friend_request_status", { status: "accepted", from, to });
          
          const toSocket = findSocketByUserId(to);
          if (toSocket) toSocket.emit("friend_list_request");
          socket.emit("friend_list_request");
          
          console.log(`✅ Otomatik kabul: ${from} ↔ ${to}`);
          return;
        }
        
        socket.emit("friend_request_status", { status: "already_pending", from, to });
        console.log(`⚠️ İstek zaten mevcut: ${from} → ${to}`);
        return;
      }

      const blocked = await friends.findOne({
        $or: [
          { from, to, status: "blocked" },
          { from: to, to: from, status: "blocked" }
        ]
      });

      if (blocked) {
        socket.emit("friend_request_status", { status: "blocked", from, to });
        return;
      }

      await friends.insertOne({ 
        from, 
        to, 
        status: "pending",
        createdAt: new Date()
      });
      
      console.log(`👥 İstek gönderildi: ${from} → ${to}`);

      const toSocket = findSocketByUserId(to);
      if (toSocket) {
        console.log(`🔔 Bildirim gönderiliyor → ${to}`);
        toSocket.emit("friend_request", { from, to });
      } else {
        console.log(`📭 ${to} çevrimdışı, istek kaydedildi`);
      }

      socket.emit("friend_request_status", { status: "pending", from, to });
    });

    socket.on("accept_friend", async ({ from, to }) => {
      const friends = db.collection("friends");
      
      const result = await friends.updateOne(
        { from, to, status: "pending" },
        { $set: { status: "accepted", acceptedAt: new Date() } }
      );

      if (result.modifiedCount === 1) {
        console.log(`✅ Arkadaşlık kabul edildi: ${from} ↔ ${to}`);

        const fromSocket = findSocketByUserId(from);
        const toSocket = findSocketByUserId(to);

        if (fromSocket) {
          fromSocket.emit("friend_list_request");
          fromSocket.emit("friend_accepted", { from, to });
        }
        if (toSocket) {
          toSocket.emit("friend_list_request");
        }
      }
    });

    socket.on("reject_friend", async ({ from, to }) => {
      const friends = db.collection("friends");
      await friends.deleteOne({ from, to, status: "pending" });
      console.log(`❌ Arkadaşlık reddedildi: ${from} → ${to}`);

      const fromSocket = findSocketByUserId(from);
      const toSocket = findSocketByUserId(to);
      if (fromSocket) fromSocket.emit("friend_list_request");
      if (toSocket) toSocket.emit("friend_list_request");
    });

    socket.on("remove_friend", async ({ from, to }) => {
      const friends = db.collection("friends");
      await friends.deleteMany({
        $or: [
          { from, to, status: "accepted" },
          { from: to, to: from, status: "accepted" },
        ],
      });
      console.log(`🗑️ Arkadaş silindi: ${from} ↔ ${to}`);

      const fromSocket = findSocketByUserId(from);
      const toSocket = findSocketByUserId(to);
      if (fromSocket) fromSocket.emit("friend_list_request");
      if (toSocket) toSocket.emit("friend_list_request");
    });

    socket.on("block_friend", async ({ from, to }) => {
      const friends = db.collection("friends");
      
      await friends.deleteMany({
        $or: [
          { from, to },
          { from: to, to: from },
        ],
      });
      
      await friends.insertOne({ 
        from, 
        to, 
        status: "blocked",
        blockedAt: new Date()
      });
      
      console.log(`⛔ Kullanıcı engellendi: ${from} ✋ ${to}`);

      const fromSocket = findSocketByUserId(from);
      const toSocket = findSocketByUserId(to);
      if (fromSocket) fromSocket.emit("friend_list_request");
      if (toSocket) toSocket.emit("friend_list_request");
    });

    // ==================== BEKLEYEN İSTEKLER ====================
    
    socket.on("get_pending_requests", async ({ userId }) => {
      const friends = db.collection("friends");
      const pending = await friends.find({
        to: userId,
        status: "pending"
      }).toArray();

      socket.emit("pending_requests", pending.map(req => ({ 
        from: req.from, 
        to: req.to,
        createdAt: req.createdAt
      })));
      
      console.log(`📬 Bekleyen istekler gönderildi: ${userId} (${pending.length} adet)`);
    });

    // ==================== DURUM YÖNETİMİ ====================
    
    socket.on("update_status", async ({ userId, status }) => {
      const [gameName, tagLine] = userId.split("#");
      const users = db.collection("users");
      
      // Geçerli status değerleri: online, away, busy, offline
      const validStatuses = ["online", "away", "busy", "offline"];
      const normalizedStatus = validStatuses.includes(status) ? status : "offline";
      
      // UPSERT kullan
      const result = await users.updateOne(
        { gameName, tagLine },
        { 
          $set: { status: normalizedStatus, lastSeen: new Date() },
          $setOnInsert: { 
            avatar: null,
            displayName: null,
            statusMessage: null,
            createdAt: new Date()
          }
        },
        { upsert: true }
      );
      
      console.log(`🌐 Durum güncellendi: ${userId} → ${normalizedStatus} (matched: ${result.matchedCount}, upserted: ${result.upsertedCount || 0})`);
      
      // Arkadaşlara status değişikliğini bildir
      await notifyFriendsOfStatusChange(userId, normalizedStatus);
      
      // Genel yayın
      io.emit("user_status", { userId, status: normalizedStatus });
    });

    // ==================== OYUN AKTİVİTESİ ====================
    
    socket.on("update_game_activity", async ({ userId, activity }) => {
      const [gameName, tagLine] = userId.split("#");
      const users = db.collection("users");
      
      await users.updateOne(
        { gameName, tagLine },
        { 
          $set: { 
            gameActivity: activity,
            activityUpdatedAt: new Date()
          }
        },
        { upsert: true }
      );
      
      console.log(`🎮 Oyun aktivitesi: ${userId} → ${activity.activity}`);
      
      const friends = await getFriendIds(userId);
      friends.forEach(friendId => {
        const friendSocket = findSocketByUserId(friendId);
        if (friendSocket) {
          friendSocket.emit("friend_activity_changed", { 
            userId, 
            activity 
          });
        }
      });
    });

    socket.on("get_user_status", async ({ userId }) => {
      const [gameName, tagLine] = userId.split("#");
      const users = db.collection("users");
      const user = await users.findOne({ gameName, tagLine });
      
      const onlineSocket = findSocketByUserId(userId);
      const status = onlineSocket ? (user?.status || "online") : (user?.status ?? "offline");
      
      socket.emit("user_status_response", { 
        userId, 
        status,
        lastSeen: user?.lastSeen
      });
      
      console.log(`📡 Status sorgulandı: ${userId} → ${status}`);
    });

    // ==================== PROFİL YÖNETİMİ ====================
    
    socket.on("update_profile", async ({ userId, avatar, displayName, statusMessage }) => {
      const [gameName, tagLine] = userId.split("#");
      const users = db.collection("users");
      
      const existingUser = await users.findOne({ gameName, tagLine });
      console.log(`🔍 Profil güncelleme - Kullanıcı aranıyor: gameName="${gameName}", tagLine="${tagLine}"`);
      console.log(`🔍 Bulunan kullanıcı:`, existingUser ? `ID: ${existingUser._id}` : 'YOK - Yeni oluşturulacak');
      
      const updateFields = {};
      if (avatar !== undefined) updateFields.avatar = avatar;
      if (displayName !== undefined) updateFields.displayName = displayName;
      if (statusMessage !== undefined) updateFields.statusMessage = statusMessage;
      updateFields.updatedAt = new Date();
      
      const result = await users.updateOne(
        { gameName, tagLine },
        { 
          $set: updateFields,
          $setOnInsert: { 
            status: 'online',
            createdAt: new Date()
          }
        },
        { upsert: true }
      );
      
      console.log(`👤 Profil güncellendi: ${userId}`, updateFields);
      console.log(`📊 Update sonucu: matched=${result.matchedCount}, modified=${result.modifiedCount}, upserted=${result.upsertedCount || 0}`);
      
      const updatedUser = await users.findOne({ gameName, tagLine });
      console.log(`✅ Güncel profil:`, {
        avatar: updatedUser?.avatar,
        displayName: updatedUser?.displayName,
        statusMessage: updatedUser?.statusMessage
      });
      
      socket.emit("profile_updated", { success: true, userId });
      
      const friends = await getFriendIds(userId);
      friends.forEach(friendId => {
        const friendSocket = findSocketByUserId(friendId);
        if (friendSocket) {
          friendSocket.emit("friend_profile_updated", { 
            oderId: userId,
            ...updateFields 
          });
        }
      });
    });

    socket.on("get_user_profile", async ({ userId }) => {
      const [gameName, tagLine] = userId.split("#");
      const users = db.collection("users");
      const user = await users.findOne({ gameName, tagLine });
      
      if (user) {
        socket.emit("user_profile_response", {
          userId,
          gameName: user.gameName,
          tagLine: user.tagLine,
          avatar: user.avatar,
          displayName: user.displayName,
          statusMessage: user.statusMessage,
          status: user.status,
          lastSeen: user.lastSeen
        });
        console.log(`👤 Profil sorgulandı: ${userId} → avatar: ${user.avatar}, displayName: ${user.displayName}, statusMessage: ${user.statusMessage}`);
      } else {
        socket.emit("user_profile_response", null);
        console.log(`👤 Profil sorgulandı: ${userId} → BULUNAMADI`);
      }
    });

    // ==================== ARKADAŞ LİSTESİ ====================
    
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
        console.log(`📋 Arkadaş listesi boş: ${userId}`);
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

      const messages = db.collection("messages");
      const lastMessages = await Promise.all(
        userList.map(async (friendId) => {
          const lastMsg = await messages
            .find({
              $or: [
                { from: userId, to: friendId },
                { from: friendId, to: userId }
              ]
            })
            .sort({ timestamp: -1 })
            .limit(1)
            .toArray();
          return { friendId, lastMessage: lastMsg[0] };
        })
      );

      const unreadCounts = await Promise.all(
        userList.map(async (friendId) => {
          const count = await messages.countDocuments({
            from: friendId,
            to: userId,
            isRead: false
          });
          return { friendId, unread: count };
        })
      );

      const enriched = relations.map((rel) => {
        const friendId = rel.from === userId ? rel.to : rel.from;
        const [g, t] = friendId.split("#");
        const profile = profiles.find((p) => p.gameName === g && p.tagLine === t);
        
        // Socket bağlı mı kontrol et ve status'u doğru belirle
        const onlineSocket = findSocketByUserId(friendId);
        
        // Öncelik: veritabanındaki status (online/away/busy/offline)
        // Eğer socket bağlıysa ve status yoksa, online varsay
        let status;
        if (profile?.status) {
          status = profile.status;
        } else if (onlineSocket) {
          status = "online";
        } else {
          status = "offline";
        }
        
        const lastMsgData = lastMessages.find(m => m.friendId === friendId);
        const unreadData = unreadCounts.find(u => u.friendId === friendId);

        return {
          oderId: friendId,
          gameName: g,
          tagLine: t,
          status,
          avatar: profile?.avatar ?? null,
          displayName: profile?.displayName ?? null,
          statusMessage: profile?.statusMessage ?? null,
          gameActivity: profile?.gameActivity ?? null,
          lastSeen: profile?.lastSeen ?? null,
          lastMessage: lastMsgData?.lastMessage?.message ?? null,
          lastMessageTime: lastMsgData?.lastMessage?.timestamp ?? null,
          unreadCount: unreadData?.unread ?? 0,
          direction: rel.from === userId ? "sent" : "received",
          from: rel.from,
          to: rel.to,
        };
      });

      // Son mesaj zamanına göre sırala
      enriched.sort((a, b) => {
        if (!a.lastMessageTime && !b.lastMessageTime) return 0;
        if (!a.lastMessageTime) return 1;
        if (!b.lastMessageTime) return -1;
        return new Date(b.lastMessageTime) - new Date(a.lastMessageTime);
      });

      socket.emit("friend_list", enriched);
      console.log(`📋 Arkadaş listesi gönderildi: ${userId} (${enriched.length} arkadaş)`);
    });

    // ==================== MESAJLAŞMA ====================
    
    socket.on("send_message", async ({ from, to, message }) => {
      const messages = db.collection("messages");
      const msg = {
        from,
        to,
        message,
        timestamp: new Date(),
        isRead: false,
      };
      
      const result = await messages.insertOne(msg);
      msg._id = result.insertedId;
      
      console.log(`📨 Mesaj gönderildi: ${from} → ${to}`);
      
      const fromSocket = findSocketByUserId(from);
      const toSocket = findSocketByUserId(to);
      
      if (fromSocket) fromSocket.emit("receive_message", msg);
      if (toSocket) toSocket.emit("receive_message", msg);
    });

    socket.on("get_messages", async ({ from, to }) => {
      const messages = db.collection("messages");
      const result = await messages
        .find({ $or: [{ from, to }, { from: to, to: from }] })
        .sort({ timestamp: 1 })
        .toArray();
      console.log(`📬 Mesajlar alındı: ${from} ↔ ${to} (${result.length} mesaj)`);
      socket.emit("chat_messages", result);
    });

    socket.on("read_messages", async ({ from, to }) => {
      const messages = db.collection("messages");
      
      const updateResult = await messages.updateMany(
        { from, to, isRead: false },
        { $set: { isRead: true, readAt: new Date() } }
      );
      
      console.log(`📘 Okundu işaretlendi: ${from} → ${to} (${updateResult.modifiedCount} mesaj)`);

      if (updateResult.modifiedCount > 0) {
        const updatedMessages = await messages
          .find({ $or: [{ from, to }, { from: to, to: from }] })
          .sort({ timestamp: 1 })
          .toArray();

        const fromSocket = findSocketByUserId(from);
        const toSocket = findSocketByUserId(to);
        if (fromSocket) fromSocket.emit("messages_updated", updatedMessages);
        if (toSocket) toSocket.emit("messages_updated", updatedMessages);
      }
    });

    socket.on("delete_message", async ({ messageId, from, to }) => {
      const messages = db.collection("messages");
      
      try {
        const result = await messages.deleteOne({ _id: new ObjectId(messageId) });
        
        if (result.deletedCount === 1) {
          console.log(`🗑️ Mesaj silindi: ${messageId}`);
          
          const fromSocket = findSocketByUserId(from);
          const toSocket = findSocketByUserId(to);
          
          if (fromSocket) fromSocket.emit("message_deleted", { _id: messageId });
          if (toSocket) toSocket.emit("message_deleted", { _id: messageId });
        }
      } catch (err) {
        console.error(`❌ Mesaj silme hatası: ${err.message}`);
      }
    });

    socket.on("delete_chat", async ({ from, to }) => {
      const messages = db.collection("messages");
      const result = await messages.deleteMany({
        $or: [
          { from, to },
          { from: to, to: from }
        ]
      });
      
      console.log(`🗑️ Sohbet silindi: ${from} ↔ ${to} (${result.deletedCount} mesaj)`);
      
      const fromSocket = findSocketByUserId(from);
      const toSocket = findSocketByUserId(to);
      
      if (fromSocket) fromSocket.emit("chat_deleted", { from, to });
      if (toSocket) toSocket.emit("chat_deleted", { from, to });
    });

    // ==================== BAĞLANTI KESİLME ====================
    
    socket.on("disconnect", async () => {
      if (socket.userId) {
        const [gameName, tagLine] = socket.userId.split("#");
        const users = db.collection("users");
        
        await users.updateOne(
          { gameName, tagLine },
          { $set: { status: "offline", lastSeen: new Date() } }
        );
        
        // Arkadaşlara offline durumunu bildir
        await notifyFriendsOfStatusChange(socket.userId, "offline");
        
        // Genel yayın
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
