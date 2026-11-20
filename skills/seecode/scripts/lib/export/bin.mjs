// Localiza executáveis externos (ffmpeg, Chrome no Linux) só em diretórios
// absolutos do PATH e sempre devolve caminho absoluto. Um nome solto passado
// ao spawn, no Windows, é procurado antes na pasta atual: um ffmpeg.exe
// deixado num repositório clonado rodaria no lugar do verdadeiro.
import { accessSync, statSync, constants } from 'node:fs';
import path from 'node:path';

export function findExecutable(name, { env = process.env, platform = process.platform } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const exts = platform === 'win32' ? ['.exe', '.com'] : [''];
  const list = String(env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':');
  for (const raw of list) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1');
    // '' e '.' (ou qualquer entrada relativa) significam a pasta atual
    if (!dir || !p.isAbsolute(dir)) continue;
    for (const ext of exts) {
      const file = p.join(dir, name + ext);
      if (isRunnable(file, platform)) return file;
    }
  }
  return null;
}

function isRunnable(file, platform) {
  try {
    if (!statSync(file).isFile()) return false;
    if (platform !== 'win32') accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// SEECODE_FFMPEG aponta um ffmpeg específico; só vale como caminho absoluto.
export function ffmpegPath(env = process.env) {
  const own = env.SEECODE_FFMPEG;
  if (own) return path.isAbsolute(own) && isRunnable(own, process.platform) ? own : null;
  return findExecutable('ffmpeg', { env });
}
