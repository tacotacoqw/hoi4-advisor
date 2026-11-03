// 开机自动在后台启动：~/Library/LaunchAgents 里放一个启动项，登录时带 --hidden 拉起参谋（不弹窗口）。
// KeepAlive.SuccessfulExit=false：崩溃了 launchd 会重新拉起；用户从菜单栏正常退出（退出码 0）就不拉。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const launchctl = (verb) => execFile('launchctl', [verb, `gui/${process.getuid()}/${LABEL}`], () => {});

const LABEL = 'local.hoi4-advisor';
const FILE = path.join(os.homedir(), 'Library/LaunchAgents', `${LABEL}.plist`);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// 只有装好的 App（/Applications/参谋电报机.app）才设开机启动；开发时 npm start 不动它
function packagedExec() {
  const exe = process.execPath;
  return /\.app\/Contents\/MacOS\//.test(exe) && !exe.includes('node_modules') ? exe : null;
}

function isEnabled() {
  try { return fs.readFileSync(FILE, 'utf8').includes(esc(packagedExec() || '\0')); } catch { return false; }
}

function enable() {
  const exe = packagedExec();
  if (!exe) return false;
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${esc(exe)}</string><string>--hidden</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
`;
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, plist);
  launchctl('enable'); // 清掉之前关开关留下的 disable 记录
  return true;
}

// 关掉：删启动项并让 launchd 记住“别再拉起”（当前这次运行不受影响，免得把自己关掉）
function disable() {
  try { fs.unlinkSync(FILE); } catch {}
  launchctl('disable');
}

module.exports = { enable, disable, isEnabled, packagedExec, FILE, LABEL };
