# Video Creator Workflow — Project Memory

Bản ghi nhớ toàn diện về kiến trúc, lịch sử xử lý lỗi và các giải pháp kỹ thuật cốt lõi của hệ thống Video Creator Workflow.

## 1. Tổng Quan Dự Án
Hệ thống tự động hóa sản xuất video AI quy mô lớn (Bulk Video Production) sử dụng mô hình DAG (Directed Acyclic Graph) để kết nối các service AI (Gemini, ChatGPT, Google Flow).

## 2. Chi tiết Hạ tầng VPS
- **Nhà cung cấp**: Google Cloud Platform (GCP).
- **Tên Instance**: `instance-template-20260309-20260309-113128-a`
- **Vùng (Zone)**: `asia-southeast1-a`
- **Domain chính**: `thhflow.com`
- **Thư mục ứng dụng**: `/opt/vcw/app`
- **User hệ thống**: `truonghoanghuy`
- **Môi trường**: Ubuntu, Xvfb (cho headless browser), Nginx (Reverse Proxy).
- **Cách SSH vào VPS**: 
  ```bash
  gcloud compute ssh instance-template-20260309-20260309-113128-a --zone=asia-southeast1-a --tunnel-through-iap
  ```

## 3. Kiến Trúc Kỹ Thuật
- **Backend**: Node.js, Express, Prisma, SQLite.
- **Frontend**: React Flow (Canvas), Vite, Socket.IO (Real-time monitoring).
- **Automation**: Puppeteer-core điều khiển Chrome thực (Native Chrome) để vượt qua các cơ chế chống bot.
- **Deployment**: Google Cloud VPS (Ubuntu), Nginx Reverse Proxy, CI/CD qua GitHub Actions.

## 3. Nhật Ký Giải Quyết Các Vấn Đề Quan Trọng (Critical Memory)

### 3.1. Khắc Phục Lỗi Google Flow reCAPTCHA 403
- **Vấn đề**: Lỗi `PUBLIC_ERROR_UNUSUAL_ACTIVITY` (403) liên tục khi chạy trên VPS GCP.
- **Nguyên nhân gốc**: 
    1. Chrome bị crash để lại file `SingletonLock` khiến các lần khởi động sau thất bại âm thầm.
    2. Việc thiết lập cookie sai domain (`labs.google` thay vì `.google.com`) làm giảm điểm tin cậy reCAPTCHA.
    3. IP của trung tâm dữ liệu (GCP) bị soi kỹ hơn IP dân dụng.
- **Giải pháp (Implemented in `acc3a26`)**:
    - **Persistence**: Duy trì Chrome profile mở liên tục (idle timeout 10m) để tích lũy điểm tin cậy.
    - **Self-Healing**: Tự động xóa file `SingletonLock/Socket/Cookie` trước khi launch.
    - **Cookie Domain Integrity**: Chỉ gọi `setCookie` cho profile mới. Nếu profile đã có cookies trên đĩa, giữ nguyên để bảo toàn domain `.google.com`.
    - **Session Recovery**: Phát hiện redirect về trang login, tự động xóa cookies cũ và nạp lại từ database (CookieHarvester).

### 3.2. Quản Lý Lifecycle Browser
- Sử dụng cơ chế `_chromePool` để quản lý mỗi tài khoản Google là một instance Chrome riêng biệt, tránh lãng phí tài nguyên và xung đột session.
- Chuyển DISPLAY sang `:99` (Xvfb) để chạy browser trên môi trường server không có GUI.

### 3.3. Xử Lý Token & Session
- **CookieHarvester**: Hệ thống vệ tinh tự động trích xuất Bearer Token và Cookies từ trình duyệt người dùng để nạp vào DB.
- **Auto-Refresh**: Tự động gọi API `/auth/session` để làm mới token trước khi hết hạn (buffer 5 phút).

## 4. Cấu Trúc Thư Mục Quan Trọng
- `/server/src/connectors/google-flow/`: Chứa `connector.js` - logic core xử lý reCAPTCHA và API Google Flow.
- `/server/src/services/browser-manager.js`: Quản lý việc khởi động Chrome và cấu hình Xvfb.
- `/mcp-server/`: Chứa logic tích hợp cho Claude/Antigravity điều khiển trực tiếp các công cụ generation.
- `/uploads/`: Chứa các profile Chrome và file media tạm thời.

## 5. Quy Trình Bảo Trì VPS
- **Restart Server**: `pm2 restart vcw-server --update-env`.
- **Xem Log**: `pm2 logs vcw-server --lines 100`.
- **Dọn dẹp Chrome treo**: `pkill -f chrome`.
- **Kiểm tra reCAPTCHA**: Chạy script `node test-recaptcha-vps.mjs` (Lưu ý: Script này dùng `sqlite3` CLI để tương thích môi trường VPS ESM).

---
*Cập nhật lần cuối: 14/05/2026*
