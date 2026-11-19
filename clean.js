// حفر ودفن: bad words in chat become stars. Used by the room chat, the in-game chat, the diwaniya chat and private messages.
'use strict';
// exact words (after normalising): the whole word must match
const EXACT = ['كلب', 'كلبه', 'كلاب', 'حمار', 'حماره', 'حمير', 'حيوان', 'حيوانه', 'غبي', 'غبيه', 'اغبياء', 'زق', 'خرا', 'خره', 'خراء', 'تفو', 'خول', 'خوال', 'زب', 'زبي', 'زبك', 'كس', 'كسي', 'طيز', 'طيزك', 'لوطي', 'واطي', 'سافل', 'سافله', 'حقير', 'حقيره', 'وسخ', 'وسخه', 'زباله', 'تافه', 'نذل', 'خنزير', 'عاهر', 'عاهره', 'ديوث', 'قواد', 'منيك', 'انيك', 'نيك', 'ينيك', 'تنيك', 'يلعن', 'العن', 'عير', 'عيري', 'كواد', 'هطف', 'مخنث',
  'ass', 'dick', 'cock', 'fag', 'slut', 'whore', 'cunt', 'bastard', 'idiot', 'stupid', 'kos', 'zeb', 'kalb', 'khara', 'teez', '6eez', 'kahba', 'manyak', 'manyok'];
// roots: any word that contains one of these
const PART = ['شرموط', 'قحب', 'منيوك', 'متناك', 'كسم', 'كسخت', 'كساخت', 'نياك', 'منايك', 'ولدالكلب', 'ابنالكلب', 'بنتالكلب', 'ولدالحرام', 'ابنالحرام',
  'fuck', 'shit', 'bitch', 'asshole', 'pussy', 'nigg', 'motherf', 'kosomak', 'kosomk', 'kosom', 'sharmo', 'sharmu', 'kuss'];
const EX = new Set(EXACT);
const norm = w => w.toLowerCase().replace(/[ً-ٰٟـ]/g, '').replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي').replace(/(.)\1+/g, '$1');
const strip = w => { for (const p of ['وال', 'يال', 'بال', 'ال', 'يا', 'و', 'ي']) if (w.length - p.length >= 2 && w.startsWith(p)) { const r = w.slice(p.length); if (EX.has(r)) return r } return w };
function bad(tok) { const n = norm(tok); if (n.length < 2) return false; if (EX.has(n) || EX.has(strip(n))) return true; for (const p of PART) if (n.includes(p)) return true; return false }
const stars = n => '★'.repeat(Math.max(3, Math.min(n, 8)));
const WORD = /[A-Za-z0-9ء-ٰٟ-ۓ]+/g;
function mask(text) {
  let s = String(text == null ? '' : text);
  // two words that make one insult ("ابن الكلب", "ولد الحرام"): look at each pair first
  const toks = []; let m; WORD.lastIndex = 0; while ((m = WORD.exec(s))) toks.push({ a: m.index, b: m.index + m[0].length, w: m[0] });
  const hit = new Array(toks.length).fill(false);
  toks.forEach((t, i) => { if (bad(t.w)) hit[i] = true; if (i + 1 < toks.length && /^\s+$/.test(s.slice(t.b, toks[i + 1].a)) && PART.includes(norm(t.w) + norm(toks[i + 1].w))) { hit[i] = hit[i + 1] = true } });
  let out = '', pos = 0; toks.forEach((t, i) => { out += s.slice(pos, t.a) + (hit[i] ? stars(t.w.length) : t.w); pos = t.b }); return out + s.slice(pos);
}
module.exports = { mask };
