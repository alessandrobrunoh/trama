// `:skull:` → 💀. A small, common set; unknown shortcodes are left untouched.

const EMOJI: Record<string, string> = {
  smile: '😄', grin: '😁', joy: '😂', laughing: '😆', wink: '😉', blush: '😊', heart_eyes: '😍',
  sunglasses: '😎', thinking: '🤔', neutral_face: '😐', unamused: '😒', sweat_smile: '😅',
  cry: '😢', sob: '😭', angry: '😠', rage: '😡', scream: '😱', flushed: '😳', sleeping: '😴',
  skull: '💀', ghost: '👻', alien: '👽', robot: '🤖', poop: '💩', clown: '🤡', face_palm: '🤦',
  shrug: '🤷', pray: '🙏', clap: '👏', wave: '👋', ok_hand: '👌', muscle: '💪', point_up: '☝️',
  point_right: '👉', point_left: '👈', thumbsup: '👍', '+1': '👍', thumbsdown: '👎', '-1': '👎',
  raised_hands: '🙌', eyes: '👀', brain: '🧠', heart: '❤️', broken_heart: '💔', blue_heart: '💙',
  green_heart: '💚', purple_heart: '💜', sparkling_heart: '💖', fire: '🔥', sparkles: '✨',
  star: '⭐', boom: '💥', zap: '⚡', tada: '🎉', party: '🥳', confetti_ball: '🎊', trophy: '🏆',
  medal: '🏅', rocket: '🚀', bulb: '💡', warning: '⚠️', no_entry: '⛔', x: '❌',
  white_check_mark: '✅', heavy_check_mark: '✔️', check: '✅', question: '❓', exclamation: '❗',
  hourglass: '⌛', alarm_clock: '⏰', calendar: '📅', memo: '📝', pencil: '✏️', book: '📖',
  bookmark: '🔖', pushpin: '📌', paperclip: '📎', link: '🔗', lock: '🔒', unlock: '🔓', key: '🔑',
  mag: '🔍', bell: '🔔', mega: '📣', speech_balloon: '💬', email: '📧', inbox_tray: '📥',
  package: '📦', hammer: '🔨', wrench: '🔧', gear: '⚙️', bug: '🐛', beetle: '🐞', ant: '🐜',
  shield: '🛡️', computer: '💻', keyboard: '⌨️', floppy_disk: '💾', chart_with_upwards_trend: '📈',
  chart_with_downwards_trend: '📉', money_with_wings: '💸', moneybag: '💰', gift: '🎁',
  coffee: '☕', beer: '🍺', pizza: '🍕', cake: '🍰', cookie: '🍪', apple: '🍎', tea: '🍵',
  sun: '☀️', moon: '🌙', cloud: '☁️', rainbow: '🌈', snowflake: '❄️', umbrella: '☔',
  earth_africa: '🌍', seedling: '🌱', evergreen_tree: '🌲', four_leaf_clover: '🍀',
  dog: '🐶', cat: '🐱', unicorn: '🦄', turtle: '🐢', snail: '🐌', penguin: '🐧', see_no_evil: '🙈',
  hear_no_evil: '🙉', speak_no_evil: '🙊', checkered_flag: '🏁', construction: '🚧',
  recycle: '♻️', hundred: '💯', arrow_right: '➡️', arrow_left: '⬅️', arrow_up: '⬆️',
  arrow_down: '⬇️', rewind: '⏪', fast_forward: '⏩', pause_button: '⏸️', stop_button: '⏹️',
};

const SHORTCODE = /:([a-z0-9_+-]+):/g;

/** Replaces every known `:shortcode:` in `text` with its emoji. */
export function replaceEmojiShortcodes(text: string): string {
  return text.replace(SHORTCODE, (whole, name: string) => EMOJI[name] ?? whole);
}
