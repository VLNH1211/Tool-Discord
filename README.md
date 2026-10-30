# 🚀 Discord Account Mission Control Suite & Activity Automator

Bộ công cụ toàn diện quản lý tài khoản Discord và tự động hóa các huy hiệu hoạt động (**Discord Activity Badges**), hỗ trợ chạy **Local** hoặc triển khai **Cloud/VPS 24/7**.

---

## 🌟 TÍNH NĂNG CHÍNH

### 1. 🖥️ Headless Auto Streamer 5000h (Huy hiệu Stream "Đã stream cho người khác")
* Tự động kết nối WebRTC Voice Gateway và phát luồng **Go Live (Screen Share)** chạy ngầm 100% trên server Node.js.
* **Tự động đưa tài khoản phụ (Viewer)** vào phòng thoại để thỏa mãn điều kiện *"stream cho người khác"* của Discord.
* Sử dụng video tĩnh siêu nhẹ (`640x360 15 FPS`), gần như **0% CPU và băng thông mạng**, cho phép treo 24/7/365.

### 2. 🎮 Game Diversity 100+ Games Spoofer (Huy hiệu Thuyết phổ quát)
* Gửi chuỗi sự kiện phân tích Telemetry (`launch_game` + `running_game_heartbeat`) từ kho **25,000+ tựa game PC có xác minh** của Discord CDN.
* Đạt mốc **100 Games** trong vài phút để mở khóa huy hiệu.

### 3. ⏳ AFK Playtime 5000h Booster (Huy hiệu Giờ chơi Vĩnh cửu)
* Giả lập tích lũy giờ chơi cho các tựa game nổi tiếng (CS2, GTA V, LoL, Valorant, Cyberpunk 2077...).
* Duy trì session và nhịp tim định kỳ an toàn theo chuẩn Discord Desktop Client.

### 4. 🎯 Discord Quests Automator
* Tự động quét các nhiệm vụ đang mở cho tài khoản (`GET /api/v9/quests/@me`).
* Tự động đăng ký (Enroll), cày 15 phút và nhận quà tặng/khung avatar vào kho đồ.

### 5. 🎨 Presence Studio (Tùy biến trạng thái trực tuyến)
* **Fake Spotify Player:** Hiển thị đang nghe nhạc Spotify với tên bài hát, ca sĩ, album và thanh thời gian chạy thực tế (không cần liên kết tài khoản Spotify).
* **Fake Twitch Stream:** Trạng thái phát trực tiếp màu tím kèm link stream và tiêu đề.
* **Custom Game Presence:** Tạo trạng thái chơi game tùy chỉnh với **2 nút bấm chuyển hướng (Clickable Buttons)**.
* **HypeSquad & Bio:** Đổi phe HypeSquad (Bravery, Brilliance, Balance) và sửa tiểu sử hồ sơ.

### 6. 🧹 Ghost Message Purger & AFK Auto-Reply
* **Message Purger:** Quét và tự động xóa sạch tin nhắn cá nhân trong bất kỳ Channel hay tin nhắn riêng (DM) nào mà không để lại dấu vết.
* **AFK Auto-Responder:** Tự động trả lời tin nhắn riêng khi bạn vắng mặt, kèm cơ chế chống spam (cooldown từng người).

### 7. 👥 Quản lý Bạn bè & Server (Cleaners)
* Xem danh sách bạn bè, lời mời kết bạn đến/đi, danh sách chặn. Hỗ trợ hủy kết bạn hàng loạt bằng 1 click.
* Xem danh sách server đang tham gia, hỗ trợ rời nhiều server cùng lúc.

### 8. 🔒 Két Token Đa Tài Khoản & Bảo Mật (Account Vault)
* Lưu trữ và chuyển đổi nhanh giữa nhiều tài khoản Discord mà không cần đăng nhập lại.
* **OAuth2 Revoker:** Xem và thu hồi quyền các ứng dụng bên thứ ba đã cấp phép.
* **Session Manager:** Kiểm tra các phiên đăng nhập từ xa.

---

## 🚀 HƯỚNG DẪN CÀI ĐẶT & CHẠY LOCAL

### Yêu cầu
* [Node.js](https://nodejs.org) phiên bản 18 trở lên.

### Khởi chạy
```bash
# 1. Cài đặt các thư viện phụ thuộc
npm install

# 2. Khởi động máy chủ
npm start
```
Truy cập giao diện Web Dashboard tại: **`http://localhost:3000`**

---

## ☁️ HƯỚNG DẪN TRIỂN KHAI CHẠY 24/7 MIỄN PHÍ TRÊN CLOUD

Để tool cày giờ và treo stream liên tục ngay cả khi bạn **tắt máy tính**:

### Cách 1: Deploy lên Render.com + UptimeRobot (100% Free, Không cần thẻ ngân hàng)
1. Đăng ký tài khoản tại [Render.com](https://render.com) và kết nối với GitHub repository này.
2. Tạo một **New Web Service**:
   * **Runtime:** Node
   * **Build Command:** `npm install`
   * **Start Command:** `node server.js`
3. Nhấn **Create Web Service**. Sau khi hoàn tất, Render sẽ cấp cho bạn một đường link web (ví dụ: `https://ten-app.onrender.com`).
4. **Giữ tool chạy 24/7:**
   * Đăng ký tài khoản tại [UptimeRobot.com](https://uptimerobot.com).
   * Thêm một Monitor mới: Chọn loại **HTTP(s)**, dán đường link Render vào và đặt chu kỳ kiểm tra là **5 phút/lần**.
   * Tool sẽ duy trì hoạt động 24/7/365 mà không bao giờ bị tắt.

### Cách 2: Triển khai lên VPS riêng (Ubuntu / Debian)
```bash
git clone https://github.com/VLNH1211/Tool-Discord.git
cd Tool-Discord
npm install
npm install -g pm2
pm2 start server.js --name "discord-tool"
pm2 save
pm2 startup
```

---

## ⚠️ LƯU Ý BẢO MẬT
* **Tuyệt đối không chia sẻ mã Token tài khoản Discord** cho người khác.
* File `data/accounts.json` đã được đưa vào `.gitignore` để tránh bị lộ token cá nhân khi đẩy lên GitHub.

---

## 📜 Giấy phép
Phát hành theo giấy phép MIT.
