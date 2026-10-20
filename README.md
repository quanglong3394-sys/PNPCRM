# CRM Panel Plus — bản tự chạy trên máy chủ

Đây là phần mềm CRM Panel Plus đóng gói để chạy trên máy chủ của công ty, không phụ thuộc Claude. Phần mềm gồm:

- quản lý khách hàng
- Volume · Giá · SOW
- Đăng ký PNP
- CTKM first order / tour
- chứng từ và voucher
- song ngữ VI/EN

| Thành phần | Công nghệ |
|---|---|
| Giao diện | `index.html`: HTML + CSS + JavaScript thuần (Chart.js, SheetJS, pdf.js tải từ cdnjs) |
| Cầu nối | `claude-shim.js`: thay các dịch vụ lưu trữ của Claude bằng API của máy chủ này |
| Backend | `app.py`: **Python 3.12 + Flask**, chạy bằng gunicorn |
| Cơ sở dữ liệu | **SQLite** (`schema.sql`), lưu dạng tài liệu JSON theo bộ sưu tập |
| File chứng từ | lưu trên ổ đĩa ở `DATA_DIR/uploads/`, thông tin file nằm trong bảng `assets` |

## Cấu trúc thư mục

Tất cả file nằm cùng một thư mục, không có thư mục con, nên tải lên repo qua giao diện web dễ dàng:

```
.dockerignore      file bỏ qua khi build Docker
.gitignore         file bỏ qua khi đưa lên Git (dữ liệu, mật khẩu, file khách hàng)
app.py             backend Flask: API, đăng nhập, phân quyền, lệnh quản trị
claude-shim.js     cầu nối giữa giao diện và API của máy chủ này
Dockerfile         đóng gói thành container
index.html         giao diện CRM
README.md          tài liệu này
requirements.txt   thư viện Python
schema.sql         cấu trúc cơ sở dữ liệu
test_app.py        kiểm thử tự động (pytest)
```

**Bắt buộc có `index.html` và `claude-shim.js` trong repo.** Thiếu 2 file này, máy chủ vẫn chạy nhưng trang chủ chỉ báo thiếu giao diện. Hai file có thể nằm cạnh `app.py` hoặc trong thư mục `static/`.

Dữ liệu khách hàng hiện có nằm ở file `crm-data.json`, được gửi riêng. **Không đưa file này lên Git**, vì nó chứa MST, số điện thoại và địa chỉ khách. Hãy nạp vào máy chủ bằng lệnh `import` ở phần dưới.

## Chạy thử trên máy (Windows / macOS / Linux)

Cần Python 3.11 trở lên.

```bash
python -m venv .venv
# Windows: .venv\Scripts\activate      macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt

python app.py init-db
python app.py create-user admin <mat-khau> admin
python app.py import crm-data.json             # nạp dữ liệu hiện có (không bắt buộc)
python app.py run 8000
```

Mở <http://localhost:8000>. Trang hiện khung **Đăng nhập**, nhập tài khoản vừa tạo. Góc trái có nút **Đăng xuất**.

Dữ liệu nằm trong thư mục `data/`. Đổi chỗ lưu bằng biến môi trường `DATA_DIR`.

## Chạy bằng Docker

```bash
docker build -t crm-panelplus .
docker run -d --name crm -p 8000:8000 \
  -v crm-data:/data \
  -e ADMIN_USER=admin -e ADMIN_PASSWORD='<mat-khau-manh>' \
  crm-panelplus
```

- `ADMIN_USER` / `ADMIN_PASSWORD` chỉ dùng **lần chạy đầu**, khi chưa có người dùng nào.
- Volume `crm-data` giữ cơ sở dữ liệu và file chứng từ khi cập nhật container.

Nạp dữ liệu vào container:

```bash
docker cp crm-data.json crm:/tmp/crm-data.json
docker exec crm python app.py import /tmp/crm-data.json
```

## Người dùng và phân quyền

| Vai trò | Được làm |
|---|---|
| `viewer` | xem mọi trang, tải file chứng từ. Các nút nhập/sửa bị ẩn |
| `editor` | nhập liệu: khách hàng, báo cáo sản lượng, phiếu đăng ký, chứng từ, voucher, giá, SOW |
| `admin` | như editor, thêm chuyển sản lượng giữa CTKM, sao lưu/nhập dữ liệu, quản lý người dùng |

```bash
python app.py create-user sales01 <mat-khau> editor
python app.py create-user giamdoc <mat-khau> viewer
```

Admin cũng tạo người dùng qua API: `PUT /api/users/<ten>` với `{"password": "...", "role": "editor"}`.

Đăng nhập bằng khung đăng nhập của trang, lưu phiên bằng cookie, mặc định 14 ngày. Script và curl có thể dùng HTTP Basic: `curl -u admin:<mk> .../api/me`. Sai mật khẩu 10 lần trong 5 phút sẽ bị khóa tạm 5 phút.

Trang chủ `/` và các đường kiểm tra sức khỏe `/healthz`, `/health`, `/ping` **không cần đăng nhập** và luôn trả 200, nên nền tảng triển khai kiểm tra được. Trang chủ chỉ là giao diện, không chứa dữ liệu. Mọi dữ liệu (`/api/...`) và file (`/_blob/...`) đều bắt buộc đăng nhập.

## Biến môi trường

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `DATA_DIR` | `./data` (Docker: `/data`) | nơi lưu cơ sở dữ liệu và file chứng từ. **Phải là ổ lưu trữ bền**, không bị xóa khi deploy lại |
| `ADMIN_USER`, `ADMIN_PASSWORD` | — | tạo tài khoản admin đầu tiên khi chưa có người dùng nào |
| `SECRET_KEY` | tự sinh, lưu ở `DATA_DIR/.secret_key` | khóa ký cookie đăng nhập. Đặt cố định nếu chạy nhiều máy |
| `COOKIE_SECURE` | `0` | đặt `1` khi chạy sau HTTPS để cookie chỉ gửi qua HTTPS |
| `SESSION_DAYS` | `14` | số ngày giữ đăng nhập |
| `PORT` | `8000` | cổng (Docker) |

Khi đưa lên Internet **bắt buộc chạy sau HTTPS**, ví dụ nền tảng hosting, Nginx, Caddy hoặc Cloudflare Tunnel.

## Triển khai trên nền tảng hosting (Vibe Host, Render, Railway…)

1. Deploy bằng `Dockerfile` của repo này. App lắng nghe cổng `PORT`, mặc định 8000.
2. **Health check path:** đặt `/healthz`. Để mặc định `/` cũng được, vì trang chủ trả 200 không cần đăng nhập.
3. Khai báo biến môi trường `ADMIN_USER`, `ADMIN_PASSWORD`, `COOKIE_SECURE=1`.
4. Gắn **ổ lưu trữ bền (persistent volume)** vào `/data`. Nếu không, mỗi lần deploy lại sẽ mất dữ liệu và file đã tải lên.

## Sao lưu

- **Nhanh:** `python app.py export backup.json` xuất toàn bộ dữ liệu ra JSON. Admin cũng tải được qua `GET /api/export`.
- **Đầy đủ:** chép cả thư mục `DATA_DIR`, gồm `crm.sqlite3` và `uploads/`. Nên dừng app trước, hoặc dùng `sqlite3 crm.sqlite3 ".backup backup.sqlite3"`.

## API (dành cho lập trình viên)

| Phương thức | Đường dẫn | Quyền | Mô tả |
|---|---|---|---|
| GET | `/api/me` | viewer | người đang đăng nhập, vai trò |
| GET | `/api/collections/<bst>?limit=&order_by=&direction=` | viewer | danh sách tài liệu |
| GET | `/api/docs/<bst>/<id>` | viewer | một tài liệu |
| PUT | `/api/docs/<bst>/<id>` | editor | ghi đè tài liệu (header `If-Match: <version>` để chống ghi chồng) |
| PATCH | `/api/docs/<bst>/<id>` | editor | cập nhật một số trường (`{"truong": {"__delete__": true}}` để xóa trường) |
| DELETE | `/api/docs/<bst>/<id>` | editor | xóa tài liệu |
| GET | `/api/changes?since=<seq>` | viewer | các bộ sưu tập vừa thay đổi (giao diện hỏi 3 giây/lần để tự làm mới) |
| POST | `/api/assets` | editor | tải file lên (multipart `file`; PDF, ảnh, Excel, CSV; tối đa 20 MB) |
| GET | `/_blob/<id>` | viewer | mở file đã tải |
| DELETE | `/api/assets/<id>` | editor | xóa file |
| GET | `/api/export` | admin | sao lưu toàn bộ dữ liệu (JSON) |
| POST | `/api/import` | admin | nạp dữ liệu `{bst: [{id, ...}]}` |
| GET / PUT | `/api/users`, `/api/users/<ten>` | admin | quản lý người dùng |
| GET | `/healthz`, `/health`, `/ping` | công khai | kiểm tra máy chủ còn chạy |
| POST | `/api/login`, `/api/logout` | công khai | đăng nhập / đăng xuất (cookie) |
| GET | `/` | công khai | giao diện CRM (tự hiện khung đăng nhập) |

Các bộ sưu tập giao diện đang dùng:

- `customers`, `allocations`, `promos`, `vouchers`, `uploads`
- `marketPrices`, `sowData`, `reportTemplates`, `orders`
- `settings` (các tài liệu `prices`, `npps`, `catalog`)

## Kiểm thử

```bash
pip install -r requirements.txt
pytest -q
```

## Lưu ý khi chuyển từ bản trên Claude

- `crm-data.json` là dữ liệu xuất từ bản CRM chính thức trên Claude ngày 19/10/2026: 103 khách hàng, báo cáo phân bổ tháng 08, 2 CTKM, 5 voucher, bảng giá, danh sách NPP và nhật ký chứng từ. File này có MST, số điện thoại và địa chỉ khách nên đã được loại khỏi Git (`.gitignore`). Hãy giữ kín.
- **File chứng từ đã tải lên Claude không có trong bản xuất.** Số liệu đơn hàng vẫn còn, chỉ thiếu file PDF gốc. Link mở file trong hồ sơ khách sẽ báo không tìm thấy cho tới khi bạn tải lại file vào hồ sơ khách tương ứng.
- Muốn làm giao diện mới: sửa `index.html`. Phần `<script src="/static/claude-shim.js">` phải đứng trước script chính.
