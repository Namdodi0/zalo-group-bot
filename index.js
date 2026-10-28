// Shim for hosting panels that require a "main file" at the repo root.
// The bot's real entry point is src/index.js — this file only forwards to it so the panel
// does not report "Missing Main File" when it only lets you pick a file at the root.
import './src/index.js';
