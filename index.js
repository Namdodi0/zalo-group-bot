// Shim cho hosting panel yêu cầu "main file" ở thư mục gốc.
// Entry thật của bot là src/index.js — file này chỉ chuyển tiếp để panel khỏi báo
// "Missing Main File" khi nó chỉ cho chọn file ở root.
import './src/index.js';
