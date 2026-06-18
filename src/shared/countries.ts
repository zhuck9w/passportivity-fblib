// ai_geo normalization. The AI is asked to return the country whose passport / citizenship /
// visa / residency is being SOLD in a creative, as a plain Russian country name. To make sure
// we never end up with a mess of spellings («США» / «Соединённые Штаты» / «USA» / «Америка»),
// every value the model returns is snapped to ONE canonical form here, server-side.
//
// Rules for canonical names: Russian, nominative case, full name (no abbreviations), Cyrillic
// only, no special symbols (apostrophes / em-dashes / quotes / flags). «ё» is folded to «е» so
// «Соединённые» and «Соединенные» can never split into two values.

// Sentinel the model returns when geo can't be determined.
export const GEO_UNKNOWN = 'Не определено';

// Placeholder written for video creatives (mirrors videoAssessmentPlaceholder on the server).
const GEO_VIDEO = 'Видео';

// Values that are NOT real countries — excluded from the country filter's option list.
export const nonCountryGeoValues = new Set<string>([GEO_UNKNOWN, GEO_VIDEO, '']);

// Canonical country names. Spelling here is the single source of truth for display + filtering.
export const countryNamesRu: string[] = [
  // Европа
  'Австрия', 'Албания', 'Андорра', 'Беларусь', 'Бельгия', 'Болгария', 'Босния и Герцеговина',
  'Ватикан', 'Великобритания', 'Венгрия', 'Германия', 'Греция', 'Дания', 'Ирландия', 'Исландия',
  'Испания', 'Италия', 'Косово', 'Латвия', 'Литва', 'Лихтенштейн', 'Люксембург', 'Мальта',
  'Молдова', 'Монако', 'Нидерланды', 'Норвегия', 'Польша', 'Португалия', 'Россия', 'Румыния',
  'Сан-Марино', 'Северная Македония', 'Сербия', 'Словакия', 'Словения', 'Украина', 'Финляндия',
  'Франция', 'Хорватия', 'Черногория', 'Чехия', 'Швейцария', 'Швеция', 'Эстония',
  // Азия
  'Азербайджан', 'Армения', 'Афганистан', 'Бангладеш', 'Бахрейн', 'Бруней', 'Бутан',
  'Восточный Тимор', 'Вьетнам', 'Грузия', 'Израиль', 'Индия', 'Индонезия', 'Иордания', 'Ирак',
  'Иран', 'Йемен', 'Казахстан', 'Камбоджа', 'Катар', 'Кипр', 'Киргизия', 'Китай', 'Кувейт',
  'Лаос', 'Ливан', 'Малайзия', 'Мальдивы', 'Монголия', 'Мьянма', 'Непал',
  'Объединенные Арабские Эмираты', 'Оман', 'Пакистан', 'Палестина', 'Саудовская Аравия',
  'Северная Корея', 'Сингапур', 'Сирия', 'Таджикистан', 'Таиланд', 'Туркменистан', 'Турция',
  'Узбекистан', 'Филиппины', 'Шри-Ланка', 'Южная Корея', 'Япония',
  // Африка
  'Алжир', 'Ангола', 'Бенин', 'Берег Слоновой Кости', 'Ботсвана', 'Буркина-Фасо', 'Бурунди',
  'Габон', 'Гамбия', 'Гана', 'Гвинея', 'Гвинея-Бисау', 'Демократическая Республика Конго',
  'Джибути', 'Египет', 'Замбия', 'Зимбабве', 'Кабо-Верде', 'Камерун', 'Кения', 'Коморы',
  'Лесото', 'Либерия', 'Ливия', 'Маврикий', 'Мавритания', 'Мадагаскар', 'Малави', 'Мали',
  'Марокко', 'Мозамбик', 'Намибия', 'Нигер', 'Нигерия', 'Республика Конго', 'Руанда',
  'Сан-Томе и Принсипи', 'Сейшельские Острова', 'Сенегал', 'Сомали', 'Судан', 'Сьерра-Леоне',
  'Танзания', 'Того', 'Тунис', 'Уганда', 'Центральноафриканская Республика', 'Чад',
  'Экваториальная Гвинея', 'Эритрея', 'Эсватини', 'Эфиопия', 'Южно-Африканская Республика',
  'Южный Судан',
  // Северная и Центральная Америка, Карибы
  'Антигуа и Барбуда', 'Багамы', 'Барбадос', 'Белиз', 'Гаити', 'Гватемала', 'Гондурас',
  'Гренада', 'Доминика', 'Доминиканская Республика', 'Канада', 'Коста-Рика', 'Куба', 'Мексика',
  'Никарагуа', 'Панама', 'Сальвадор', 'Сент-Винсент и Гренадины', 'Сент-Китс и Невис',
  'Сент-Люсия', 'Соединенные Штаты Америки', 'Тринидад и Тобаго', 'Ямайка',
  // Южная Америка
  'Аргентина', 'Боливия', 'Бразилия', 'Венесуэла', 'Гайана', 'Колумбия', 'Парагвай', 'Перу',
  'Суринам', 'Уругвай', 'Чили', 'Эквадор',
  // Океания
  'Австралия', 'Вануату', 'Кирибати', 'Маршалловы Острова', 'Микронезия', 'Науру',
  'Новая Зеландия', 'Палау', 'Папуа-Новая Гвинея', 'Самоа', 'Соломоновы Острова', 'Тонга',
  'Тувалу', 'Фиджи'
];

// Variant / abbreviation / English spellings → canonical name. Keys are matched after the same
// folding applied to the model output (see geoKey), so case / «ё» / hyphens don't matter here.
const aliasToCanonical: Record<string, string> = {
  // США
  'сша': 'Соединенные Штаты Америки',
  'америка': 'Соединенные Штаты Америки',
  'соединенные штаты': 'Соединенные Штаты Америки',
  'штаты': 'Соединенные Штаты Америки',
  'usa': 'Соединенные Штаты Америки',
  'us': 'Соединенные Штаты Америки',
  'united states': 'Соединенные Штаты Америки',
  'united states of america': 'Соединенные Штаты Америки',
  // ОАЭ
  'оаэ': 'Объединенные Арабские Эмираты',
  'эмираты': 'Объединенные Арабские Эмираты',
  'uae': 'Объединенные Арабские Эмираты',
  'united arab emirates': 'Объединенные Арабские Эмираты',
  'дубай': 'Объединенные Арабские Эмираты',
  'абу даби': 'Объединенные Арабские Эмираты',
  // Великобритания
  'англия': 'Великобритания',
  'британия': 'Великобритания',
  'соединенное королевство': 'Великобритания',
  'великобритания и северная ирландия': 'Великобритания',
  'uk': 'Великобритания',
  'united kingdom': 'Великобритания',
  'great britain': 'Великобритания',
  // ЮАР
  'юар': 'Южно-Африканская Республика',
  'south africa': 'Южно-Африканская Республика',
  // Корея
  'корея': 'Южная Корея',
  'республика корея': 'Южная Корея',
  'south korea': 'Южная Корея',
  'кндр': 'Северная Корея',
  'north korea': 'Северная Корея',
  // Прочие частые варианты
  'чешская республика': 'Чехия',
  'молдавия': 'Молдова',
  'кыргызстан': 'Киргизия',
  'белоруссия': 'Беларусь',
  'бирма': 'Мьянма',
  'голландия': 'Нидерланды',
  'святой престол': 'Ватикан',
  'македония': 'Северная Македония',
  'свазиленд': 'Эсватини',
  'острова зеленого мыса': 'Кабо-Верде',
  'тимор-лесте': 'Восточный Тимор',
  'кот-д ивуар': 'Берег Слоновой Кости',
  'кот д ивуар': 'Берег Слоновой Кости',
  "кот-д'ивуар": 'Берег Слоновой Кости',
  'конго': 'Демократическая Республика Конго',
  'папуа новая гвинея': 'Папуа-Новая Гвинея',
  'монтенегро': 'Черногория',
  // English spellings of the common citizenship/residency markets
  'turkey': 'Турция',
  'turkiye': 'Турция',
  'malta': 'Мальта',
  'cyprus': 'Кипр',
  'portugal': 'Португалия',
  'spain': 'Испания',
  'greece': 'Греция',
  'montenegro': 'Черногория',
  'serbia': 'Сербия',
  'egypt': 'Египет',
  'jordan': 'Иордания',
  'vanuatu': 'Вануату',
  'grenada': 'Гренада',
  'dominica': 'Доминика',
  'saint lucia': 'Сент-Люсия',
  'st lucia': 'Сент-Люсия',
  'saint kitts and nevis': 'Сент-Китс и Невис',
  'st kitts and nevis': 'Сент-Китс и Невис',
  'antigua and barbuda': 'Антигуа и Барбуда',
  'sao tome and principe': 'Сан-Томе и Принсипи',
  'saint vincent and the grenadines': 'Сент-Винсент и Гренадины'
};

// Folding key: lowercase, ё→е, hyphens/underscores → space, drop everything that isn't a
// Cyrillic/Latin letter or space, collapse whitespace. Makes lookup tolerant to punctuation.
function geoKey(value: string) {
  return value
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[-_]+/g, ' ')
    .replace(/[^a-zа-я ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const canonicalByKey: Record<string, string> = {};
for (const name of countryNamesRu) canonicalByKey[geoKey(name)] = name;
for (const [alias, canonical] of Object.entries(aliasToCanonical)) canonicalByKey[geoKey(alias)] = canonical;

// Cleanup for a piece that doesn't match any known country: keep Cyrillic letters, spaces and
// hyphens only, collapse whitespace, capitalize the first letter. Never invents data — just
// tidies whatever the model wrote so an unknown geo still looks consistent.
function cleanUnknownPiece(piece: string) {
  const cleaned = piece
    .replace(/ё/g, 'е')
    .replace(/Ё/g, 'Е')
    .replace(/[^А-Яа-я \-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*-\s*/g, '-')
    .trim();
  if (!cleaned) return '';
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

// Split a stored/returned ai_geo value into individual country tokens. Multiple geos are comma /
// semicolon / slash / newline separated — we deliberately do NOT split on « и », because it is
// part of many country names («Сан-Томе и Принсипи», «Антигуа и Барбуда», «Тринидад и Тобаго»).
export function splitGeoValues(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[,;/\n]+/)
    .map((piece) => piece.trim())
    .filter(Boolean);
}

// Normalize one raw ai_geo string from the model into the canonical, deduped, comma-joined form.
export function normalizeGeo(raw: string | null | undefined): string {
  const pieces = splitGeoValues(raw);
  if (!pieces.length) return GEO_UNKNOWN;

  const seen = new Set<string>();
  const result: string[] = [];
  for (const piece of pieces) {
    const canonical = canonicalByKey[geoKey(piece)] ?? cleanUnknownPiece(piece);
    if (!canonical || canonical === GEO_UNKNOWN) continue;
    const dedupeKey = geoKey(canonical);
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    result.push(canonical);
  }

  return result.length ? result.join(', ') : GEO_UNKNOWN;
}
