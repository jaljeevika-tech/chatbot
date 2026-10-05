// Fixed on-screen labels for Video Overview per narration language (reviewed by native
// speakers; placeholders preserved). Unlisted languages fall back to English.

export interface VideoStrings {
  kickerList: string
  kickerStat: string
  kickerQuote: string
  documentary: string
  chapter: string
  recap: string
  message: string
  sources: string
  sourcePrefix: string
  producedBy: string
  productionNotes: string
  noteVoices: string
  notePhotos: string
  noteAi: string
  provField: string
  provAi: string
  provAiPhoto: string
  provAiMotion: string
  morePlaces: string
  idleTitle: string
  idleSub: string
  /** Credit for a beneficiary-profile source (never the person's name). */
  beneficiaryProfile: string
}

export const EN_STRINGS: VideoStrings = {
  kickerList: 'KEY POINTS',
  kickerStat: 'BY THE NUMBERS',
  kickerQuote: 'IN THEIR WORDS',
  documentary: 'A FIELD DOCUMENTARY',
  chapter: 'CHAPTER {n}',
  recap: 'WHAT THE RECORDS SHOW',
  message: 'THE MESSAGE',
  sources: 'SOURCES',
  sourcePrefix: 'SOURCE',
  producedBy: 'PRODUCED BY',
  productionNotes: 'PRODUCTION NOTES',
  noteVoices: 'Narration voices are AI-generated from a script written from these sources.',
  notePhotos: 'Pictures marked {field} come from project field reports.',
  noteAi: 'Pictures marked {ai} are not photographs.',
  provField: 'FIELD PHOTO',
  provAi: 'AI ILLUSTRATION',
  provAiPhoto: 'AI-GENERATED IMAGE · NOT A PHOTO',
  provAiMotion: 'AI ANIMATION',
  morePlaces: 'and {n} more places',
  idleTitle: 'Video Overview',
  idleSub: 'Add sources and generate to preview',
  beneficiaryProfile: 'Beneficiary profile',
}

const TRANSLATIONS: Partial<Record<string, VideoStrings>> = {
  'hi-IN': {
    kickerList: "मुख्य बातें",
    kickerStat: "आँकड़ों की ज़ुबानी",
    kickerQuote: "उन्हीं के शब्दों में",
    documentary: "एक ज़मीनी वृत्तचित्र",
    chapter: "अध्याय {n}",
    recap: "रिकॉर्ड क्या बताते हैं",
    message: "मुख्य संदेश",
    sources: "स्रोत",
    sourcePrefix: "स्रोत",
    producedBy: "निर्माण",
    productionNotes: "निर्माण संबंधी टिप्पणियाँ",
    noteVoices: "वाचन की आवाज़ें AI से तैयार की गई हैं; पटकथा इन्हीं स्रोतों के आधार पर लिखी गई है।",
    notePhotos: "जिन तस्वीरों पर {field} लिखा है, वे परियोजना की ज़मीनी रिपोर्टों से ली गई हैं।",
    noteAi: "जिन तस्वीरों पर {ai} लिखा है, वे असली फ़ोटो नहीं हैं।",
    provField: "मौके की फ़ोटो",
    provAi: "AI से बना चित्र",
    provAiPhoto: "AI से बनी तस्वीर · असली फ़ोटो नहीं",
    provAiMotion: "AI से बना एनिमेशन",
    morePlaces: "और {n} अन्य स्थान",
    idleTitle: "वीडियो सारांश",
    idleSub: "झलक देखने के लिए स्रोत जोड़ें और वीडियो तैयार करें",
    beneficiaryProfile: "लाभार्थी प्रोफ़ाइल",
  },
  'mr-IN': {
    kickerList: "महत्त्वाचे मुद्दे",
    kickerStat: "आकड्यांच्या भाषेत",
    kickerQuote: "त्यांच्याच शब्दांत",
    documentary: "प्रत्यक्ष क्षेत्रातील माहितीपट",
    chapter: "प्रकरण {n}",
    recap: "नोंदी काय सांगतात",
    message: "मुख्य संदेश",
    sources: "स्रोत",
    sourcePrefix: "स्रोत",
    producedBy: "निर्मिती",
    productionNotes: "निर्मितीविषयक टिपा",
    noteVoices: "निवेदनाचे आवाज AI निर्मित आहेत; त्यांची संहिता याच स्रोतांच्या आधारे लिहिली आहे.",
    notePhotos: "ज्या चित्रांवर {field} असे लिहिले आहे, ती प्रकल्पाच्या क्षेत्रीय अहवालांतून घेतली आहेत.",
    noteAi: "ज्या चित्रांवर {ai} असे लिहिले आहे, ती खरी छायाचित्रे नाहीत.",
    provField: "प्रत्यक्ष क्षेत्रातील छायाचित्र",
    provAi: "AI निर्मित चित्र",
    provAiPhoto: "AI निर्मित प्रतिमा · खरे छायाचित्र नाही",
    provAiMotion: "AI निर्मित ॲनिमेशन",
    morePlaces: "आणि इतर {n} ठिकाणे",
    idleTitle: "व्हिडिओ आढावा",
    idleSub: "झलक पाहण्यासाठी स्रोत जोडा आणि व्हिडिओ तयार करा",
    beneficiaryProfile: "लाभार्थी प्रोफाइल",
  },
  'bn-IN': {
    kickerList: "মূল বিষয়গুলি",
    kickerStat: "সংখ্যার নিরিখে",
    kickerQuote: "তাঁদের কথায়",
    documentary: "সরেজমিন তথ্যচিত্র",
    chapter: "অধ্যায় {n}",
    recap: "নথিপত্র যা বলছে",
    message: "মূল বার্তা",
    sources: "তথ্যসূত্র",
    sourcePrefix: "সূত্র",
    producedBy: "প্রযোজনায়",
    productionNotes: "নির্মাণ সংক্রান্ত তথ্য",
    noteVoices: "এই তথ্যসূত্রগুলির ভিত্তিতে লেখা চিত্রনাট্য থেকে ভাষ্যপাঠের কণ্ঠস্বর AI দিয়ে তৈরি করা হয়েছে।",
    notePhotos: "যেসব ছবিতে ‘{field}’ লেখা আছে, সেগুলি প্রকল্পের মাঠ পর্যায়ের প্রতিবেদন থেকে নেওয়া।",
    noteAi: "যেসব ছবিতে ‘{ai}’ লেখা আছে, সেগুলি বাস্তবে তোলা ছবি নয়।",
    provField: "মাঠে তোলা ছবি",
    provAi: "AI দিয়ে আঁকা ছবি",
    provAiPhoto: "AI দিয়ে তৈরি ছবি · বাস্তবে তোলা নয়",
    provAiMotion: "AI দিয়ে তৈরি চলমান ছবি",
    morePlaces: "এবং আরও {n}টি জায়গা",
    idleTitle: "ভিডিও সারসংক্ষেপ",
    idleSub: "তথ্যসূত্র যোগ করে তৈরি করুন, তারপর এখানে দেখুন",
    beneficiaryProfile: "উপকারভোগীর প্রোফাইল",
  },
  'gu-IN': {
    kickerList: "મુખ્ય મુદ્દા",
    kickerStat: "આંકડાની નજરે",
    kickerQuote: "તેમના શબ્દોમાં",
    documentary: "જમીની સ્તરની દસ્તાવેજી ફિલ્મ",
    chapter: "પ્રકરણ {n}",
    recap: "દસ્તાવેજો શું દર્શાવે છે",
    message: "મુખ્ય સંદેશ",
    sources: "સ્રોતો",
    sourcePrefix: "સ્રોત",
    producedBy: "નિર્માણ",
    productionNotes: "નિર્માણ અંગેની નોંધ",
    noteVoices: "આ સ્રોતોના આધારે લખાયેલી પટકથા પરથી વર્ણનના અવાજો AI દ્વારા બનાવાયા છે.",
    notePhotos: "જે તસવીરો પર ‘{field}’ લખેલું છે, તે પરિયોજનાના ક્ષેત્રકાર્યના અહેવાલોમાંથી લેવામાં આવી છે.",
    noteAi: "જે ચિત્રો પર ‘{ai}’ લખેલું છે, તે વાસ્તવિક તસવીરો નથી.",
    provField: "સ્થળ પર લીધેલી તસવીર",
    provAi: "AI દ્વારા દોરેલું ચિત્ર",
    provAiPhoto: "AI દ્વારા બનાવેલી છબી · વાસ્તવિક તસવીર નથી",
    provAiMotion: "AI દ્વારા બનાવેલું ગતિશીલ દૃશ્ય",
    morePlaces: "અને વધુ {n} સ્થળો",
    idleTitle: "વીડિયો ઝાંખી",
    idleSub: "સ્રોતો ઉમેરો, પછી બનાવીને અહીં જુઓ",
    beneficiaryProfile: "લાભાર્થી પ્રોફાઇલ",
  },
  'kn-IN': {
    kickerList: "ಮುಖ್ಯ ಅಂಶಗಳು",
    kickerStat: "ಅಂಕಿಅಂಶಗಳಲ್ಲಿ",
    kickerQuote: "ಅವರದೇ ಮಾತುಗಳಲ್ಲಿ",
    documentary: "ಕ್ಷೇತ್ರ ಸಾಕ್ಷ್ಯಚಿತ್ರ",
    chapter: "ಅಧ್ಯಾಯ {n}",
    recap: "ದಾಖಲೆಗಳು ಹೇಳುವುದೇನು",
    message: "ಸಂದೇಶ",
    sources: "ಮೂಲಗಳು",
    sourcePrefix: "ಮೂಲ",
    producedBy: "ನಿರ್ಮಾಣ",
    productionNotes: "ನಿರ್ಮಾಣ ಟಿಪ್ಪಣಿಗಳು",
    noteVoices: "ಈ ಮೂಲಗಳನ್ನು ಆಧರಿಸಿ ಬರೆದ ಪಠ್ಯದಿಂದ ನಿರೂಪಣೆಯ ಧ್ವನಿಗಳನ್ನು AI ಮೂಲಕ ರಚಿಸಲಾಗಿದೆ.",
    notePhotos: "{field} ಎಂದು ಗುರುತಿಸಲಾದ ಚಿತ್ರಗಳನ್ನು ಯೋಜನೆಯ ಕ್ಷೇತ್ರ ವರದಿಗಳಿಂದ ಪಡೆಯಲಾಗಿದೆ.",
    noteAi: "{ai} ಎಂದು ಗುರುತಿಸಲಾದ ಚಿತ್ರಗಳು ಛಾಯಾಚಿತ್ರಗಳಲ್ಲ.",
    provField: "ಕ್ಷೇತ್ರ ಛಾಯಾಚಿತ್ರ",
    provAi: "AI ಚಿತ್ರಣ",
    provAiPhoto: "AI ರಚಿತ ಚಿತ್ರ · ಛಾಯಾಚಿತ್ರವಲ್ಲ",
    provAiMotion: "AI ಅನಿಮೇಷನ್",
    morePlaces: "ಮತ್ತು ಇನ್ನೂ {n} ಸ್ಥಳಗಳು",
    idleTitle: "ವೀಡಿಯೊ ಅವಲೋಕನ",
    idleSub: "ಮುನ್ನೋಟ ನೋಡಲು ಮೂಲಗಳನ್ನು ಸೇರಿಸಿ, ನಂತರ ರಚಿಸಿ",
    beneficiaryProfile: "ಫಲಾನುಭವಿ ವಿವರ",
  },
  'ml-IN': {
    kickerList: "പ്രധാന കാര്യങ്ങൾ",
    kickerStat: "കണക്കുകളിലൂടെ",
    kickerQuote: "അവരുടെ വാക്കുകളിൽ",
    documentary: "താഴെത്തട്ടിൽ നിന്നൊരു ഡോക്യുമെന്ററി",
    chapter: "അധ്യായം {n}",
    recap: "രേഖകൾ പറയുന്നത്",
    message: "സന്ദേശം",
    sources: "ഉറവിടങ്ങൾ",
    sourcePrefix: "ഉറവിടം",
    producedBy: "നിർമ്മാണം",
    productionNotes: "നിർമ്മാണ കുറിപ്പുകൾ",
    noteVoices: "വിവരണ ശബ്ദങ്ങൾ AI നിർമ്മിതമാണ്. തിരക്കഥ ഈ ഉറവിടങ്ങളെ ആധാരമാക്കി എഴുതിയതാണ്.",
    notePhotos: "{field} എന്ന് അടയാളമുള്ളവ പദ്ധതിയുടെ പ്രവർത്തന റിപ്പോർട്ടുകളിലേതാണ്.",
    noteAi: "{ai} എന്ന് അടയാളമുള്ളവ ഫോട്ടോകളല്ല.",
    provField: "സ്ഥലത്തെടുത്ത ഫോട്ടോ",
    provAi: "AI വരച്ച ചിത്രം",
    provAiPhoto: "AI നിർമ്മിത ചിത്രം · ഫോട്ടോ അല്ല",
    provAiMotion: "AI ആനിമേഷൻ",
    morePlaces: "കൂടാതെ മറ്റ് {n} സ്ഥലങ്ങളും",
    idleTitle: "വീഡിയോ അവലോകനം",
    idleSub: "പ്രിവ്യൂ കാണാൻ ഉറവിടങ്ങൾ ചേർത്ത് സൃഷ്ടിക്കുക",
    beneficiaryProfile: "ഗുണഭോക്തൃ പ്രൊഫൈൽ",
  },
  'ta-IN': {
    kickerList: "முக்கிய அம்சங்கள்",
    kickerStat: "எண்களில்",
    kickerQuote: "அவர்களின் வார்த்தைகளில்",
    documentary: "கள ஆவணப்படம்",
    chapter: "அத்தியாயம் {n}",
    recap: "பதிவுகள் காட்டுவது",
    message: "மையச் செய்தி",
    sources: "ஆதாரங்கள்",
    sourcePrefix: "ஆதாரம்",
    producedBy: "தயாரிப்பு",
    productionNotes: "தயாரிப்புக் குறிப்புகள்",
    noteVoices: "விவரிப்புக் குரல்கள் இந்த ஆதாரங்களை அடிப்படையாகக் கொண்டு எழுதப்பட்ட உரையிலிருந்து AI மூலம் உருவாக்கப்பட்டவை.",
    notePhotos: "{field} எனக் குறிக்கப்பட்ட படங்கள் திட்டத்தின் கள அறிக்கைகளிலிருந்து எடுக்கப்பட்டவை.",
    noteAi: "{ai} எனக் குறிக்கப்பட்ட படங்கள் புகைப்படங்கள் அல்ல.",
    provField: "களப் புகைப்படம்",
    provAi: "AI ஓவியம்",
    provAiPhoto: "AI உருவாக்கிய படம் · புகைப்படம் அல்ல",
    provAiMotion: "AI அனிமேஷன்",
    morePlaces: "மற்றும் மேலும் {n} இடங்கள்",
    idleTitle: "காணொளி மேலோட்டம்",
    idleSub: "முன்னோட்டம் காண ஆதாரங்களைச் சேர்த்து உருவாக்கவும்",
    beneficiaryProfile: "பயனாளர் விவரம்",
  },
  'te-IN': {
    kickerList: "ముఖ్యాంశాలు",
    kickerStat: "అంకెల్లో",
    kickerQuote: "వారి మాటల్లో",
    documentary: "క్షేత్రస్థాయి డాక్యుమెంటరీ",
    chapter: "అధ్యాయం {n}",
    recap: "నివేదికలు చెబుతున్నది",
    message: "ప్రధాన సందేశం",
    sources: "ఆధారాలు",
    sourcePrefix: "ఆధారం",
    producedBy: "నిర్మాణం",
    productionNotes: "నిర్మాణ గమనికలు",
    noteVoices: "ఈ ఆధారాలను అనుసరించి రాసిన పాఠం నుంచి వ్యాఖ్యాన స్వరాలను AI ద్వారా రూపొందించారు.",
    notePhotos: "{field} అని గుర్తించిన చిత్రాలు ప్రాజెక్టు క్షేత్రస్థాయి నివేదికల నుంచి తీసుకున్నవి.",
    noteAi: "{ai} అని గుర్తించిన చిత్రాలు ఫోటోలు కావు.",
    provField: "క్షేత్రస్థాయి ఫోటో",
    provAi: "AI గీసిన చిత్రం",
    provAiPhoto: "AI రూపొందించిన చిత్రం · ఫోటో కాదు",
    provAiMotion: "AI యానిమేషన్",
    morePlaces: "సహా మరో {n} ప్రాంతాలు",
    idleTitle: "వీడియో అవలోకనం",
    idleSub: "ముందస్తు వీక్షణ కోసం ఆధారాలను జోడించి రూపొందించండి",
    beneficiaryProfile: "లబ్ధిదారుల వివరాలు",
  },
}

export function stringsFor(languageCode: string): VideoStrings {
  return TRANSLATIONS[languageCode] ?? EN_STRINGS
}

export const fmt = (s: string, vars: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `{${k}}`))

// Fonts: brand faces (IBM Plex Sans + Newsreader) don't cover Indic scripts, so the
// matching Noto family is loaded on demand and put first in the stack.

// `sample` = a few characters of the script: Google serves each family as
// unicode-range subsets, and document.fonts.load() only fetches the subsets
// that cover the text it's given (default text is Latin → nothing Indic loads).
const NOTO: Record<string, { sans: string; serif: string; sample: string }> = {
  'hi-IN': { sans: 'Noto Sans Devanagari', serif: 'Noto Serif Devanagari', sample: 'अआकखगक्षज्ञ' },
  'mr-IN': { sans: 'Noto Sans Devanagari', serif: 'Noto Serif Devanagari', sample: 'अआकखगळक्ष' },
  'bn-IN': { sans: 'Noto Sans Bengali',    serif: 'Noto Serif Bengali',    sample: 'অআকখগক্ষ' },
  'gu-IN': { sans: 'Noto Sans Gujarati',   serif: 'Noto Serif Gujarati',   sample: 'અઆકખગક્ષ' },
  'kn-IN': { sans: 'Noto Sans Kannada',    serif: 'Noto Serif Kannada',    sample: 'ಅಆಕಖಗಕ್ಷ' },
  'ml-IN': { sans: 'Noto Sans Malayalam',  serif: 'Noto Serif Malayalam',  sample: 'അആകഖഗക്ഷ' },
  'ta-IN': { sans: 'Noto Sans Tamil',      serif: 'Noto Serif Tamil',      sample: 'அஆகஙசக்ஷ' },
  'te-IN': { sans: 'Noto Sans Telugu',     serif: 'Noto Serif Telugu',     sample: 'అఆకఖగక్ష' },
}

/** `display` is the caption face (Poppins). It covers Devanagari, so Hindi and Marathi
 *  keep it; other Indic scripts fall back to their Noto Sans. */
export interface VideoFonts { sans: string; serif: string; display: string; latin: boolean }

const POPPINS_SCRIPTS = new Set(['hi-IN', 'mr-IN'])

export function fontsFor(languageCode: string): VideoFonts {
  const n = NOTO[languageCode]
  return {
    sans:  `${n ? `"${n.sans}",` : ''}"IBM Plex Sans","Segoe UI",system-ui,sans-serif`,
    serif: `${n ? `"${n.serif}",` : ''}"Newsreader",Georgia,serif`,
    display: `"Poppins",${n ? `"${n.sans}",` : ''}"IBM Plex Sans","Segoe UI",system-ui,sans-serif`,
    latin: !n,
  }
}

const sheets = new Map<string, Promise<void>>()
/** Load the caption face and the language's Noto faces (once) and wait until the canvas can use them. */
export async function ensureFonts(languageCode: string): Promise<void> {
  const n = NOTO[languageCode]
  const families = ['Poppins', ...(n ? [n.sans, n.serif] : [])]
  for (const fam of families) {
    if (sheets.has(fam)) continue
    sheets.set(fam, new Promise<void>(resolve => {
      const link = document.createElement('link')
      link.rel = 'stylesheet'
      link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(fam)}:wght@400;500;600;700&display=swap`
      // @font-face rules only exist once the sheet has loaded — fonts.load() before that finds nothing.
      link.onload = () => resolve(); link.onerror = () => resolve()
      document.head.appendChild(link)
    }))
  }
  await Promise.all(families.map(f => sheets.get(f)))
  const latin = 'AaBb0123'
  // Poppins: its Devanagari subset only loads when asked for with Devanagari text.
  const poppinsText = POPPINS_SCRIPTS.has(languageCode) && n ? `${n.sample} ${latin}` : latin
  const faces: [string, string][] = [
    ['400 16px "IBM Plex Sans"', latin], ['600 16px "IBM Plex Sans"', latin], ['700 16px "IBM Plex Sans"', latin],
    ['400 16px "Newsreader"', latin], ['italic 400 16px "Newsreader"', latin],
    ...families.flatMap(f => [400, 500, 600, 700].map(w => [`${w} 16px "${f}"`, f === 'Poppins' ? poppinsText : `${n!.sample} ${latin}`] as [string, string])),
  ]
  try {
    await Promise.race([
      Promise.all(faces.map(([f, text]) => document.fonts.load(f, text))),
      new Promise(r => setTimeout(r, 4000)), // never block a render/export on a slow font
    ])
  } catch { /* system fallback fonts are fine */ }
}
