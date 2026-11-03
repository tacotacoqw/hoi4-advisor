// 从玩家本机的钢铁雄心4读取界面贴图、国策图标和国旗，用 ffmpeg 把 .dds/.tga 转成 png 缓存。
// 素材不进仓库（版权归 Paradox），每台电脑从自己的游戏目录现转；转不了就让界面退回纯 CSS。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const UI_TEXTURES = {
  frame: 'gfx/interface/tiles/tiled_window_2b_border.dds',
  tile: 'gfx/interface/tiles/tiled_window.dds',
  topbar: 'gfx/interface/topbar/background.dds',
  plate: 'gfx/interface/focus_popup_bg.dds',
  button: 'gfx/interface/button_type_1.dds',
  buttonSmall: 'gfx/interface/button_type_2.dds',
};
const FLAG_IDEOLOGIES = ['communism', 'neutrality', 'democratic', 'fascism'];

function findFfmpeg() {
  return ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'].find((p) => fs.existsSync(p));
}

class Gfx {
  constructor({ gamedata, cacheDir }) {
    this.gd = gamedata;
    this.cacheDir = cacheDir;
    this.ffmpeg = findFfmpeg();
    this._sprites = null;
    this.pending = new Map();
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  roots() {
    return [this.gd.gameDir, ...this.gd.mods().filter((m) => m.ok).map((m) => m.dir)];
  }

  // 相对路径（gfx/...）→ 实际文件，后加载的模组优先
  resolve(rel) {
    const clean = rel.replace(/\/\/+/g, '/').replace(/^\/+/, '');
    const roots = this.roots().reverse();
    for (const r of roots) {
      const p = path.join(r, clean);
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  // GFX_xxx → 贴图相对路径；读 interface/*.gfx 的 spriteType
  sprites() {
    if (this._sprites) return this._sprites;
    const map = new Map();
    const re = /spriteType\s*=\s*\{([^{}]*)\}/gi;
    for (const root of this.roots()) {
      let files = [];
      try { files = fs.readdirSync(path.join(root, 'interface')).filter((f) => f.endsWith('.gfx')); } catch { continue; }
      for (const f of files) {
        let text;
        try { text = fs.readFileSync(path.join(root, 'interface', f), 'utf8'); } catch { continue; }
        for (const m of text.matchAll(re)) {
          const name = (m[1].match(/name\s*=\s*"?([\w.\-]+)"?/i) || [])[1];
          const tex = (m[1].match(/texturefile\s*=\s*"([^"]+)"/i) || [])[1];
          if (name && tex) map.set(name, tex);
        }
      }
    }
    this._sprites = map;
    return map;
  }

  // 转成 png 放进缓存，返回 gfx:// 地址；失败返回 null
  async png(abs) {
    if (!abs || !this.ffmpeg) return null;
    const st = fs.statSync(abs);
    const key = crypto.createHash('md5').update(abs + st.mtimeMs).digest('hex').slice(0, 16) + '.png';
    const out = path.join(this.cacheDir, key);
    if (fs.existsSync(out)) return 'gfx://cache/' + key;
    if (!this.pending.has(key)) {
      this.pending.set(key, new Promise((resolve) => {
        // 有的贴图是多帧横条（按钮等），这里只要整张，前端用 background-position 取第一帧
        execFile(this.ffmpeg, ['-y', '-loglevel', 'error', '-i', abs, '-frames:v', '1', '-update', '1', out], { timeout: 20000 }, (err) => {
          this.pending.delete(key);
          resolve(err || !fs.existsSync(out) ? null : 'gfx://cache/' + key);
        });
      }));
    }
    return this.pending.get(key);
  }

  async ui() {
    const out = {};
    await Promise.all(Object.entries(UI_TEXTURES).map(async ([k, rel]) => { out[k] = await this.png(this.resolve(rel)); }));
    return out;
  }

  async flag(tag, ideology) {
    if (!tag) return null;
    for (const ideo of [ideology, ...FLAG_IDEOLOGIES].filter(Boolean)) {
      const p = this.resolve(`gfx/flags/${tag}_${ideo}.tga`) || this.resolve(`gfx/flags/${tag}.tga`);
      if (p) return this.png(p);
    }
    return null;
  }

  async focusIcons(ids) {
    const { focuses } = this.gd.focusIndex();
    const sprites = this.sprites();
    const out = {};
    await Promise.all(ids.map(async (id) => {
      const f = focuses.get(id);
      const tex = f && f.icon && sprites.get(f.icon);
      out[id] = tex ? await this.png(this.resolve(tex)) : null;
    }));
    return out;
  }

  // gfx://cache/<file> → 缓存目录里的文件
  fileFor(url) {
    const name = path.basename(new URL(url).pathname);
    const p = path.join(this.cacheDir, name);
    return p.startsWith(this.cacheDir) && fs.existsSync(p) ? p : null;
  }
}

module.exports = { Gfx, UI_TEXTURES };
