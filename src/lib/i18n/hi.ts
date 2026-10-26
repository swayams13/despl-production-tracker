// REVIEW: DESPL — every string below is a draft Hindi translation for a native
// speaker on the floor to approve. Do not treat any of it as final.
import type { Dict } from "./en";

export const hi: Dict = {
  langName: "हिन्दी",
  intl: "hi-IN-u-nu-latn",
  state: {
    READY: "तैयार", // REVIEW: DESPL
    IN_PROGRESS: "चालू है", // REVIEW: DESPL
    WITH_QC: "QC के पास", // REVIEW: DESPL
    QC_STEP: "QC का इंतज़ार", // REVIEW: DESPL
  },
  common: {
    start: "शुरू करें", // REVIEW: DESPL
    done: "हो गया", // REVIEW: DESPL
    markDone: "काम पूरा हुआ", // REVIEW: DESPL
    startEarly: "जल्दी शुरू करें…", // REVIEW: DESPL
    cancel: "रद्द करें", // REVIEW: DESPL
    dismiss: "बंद करें", // REVIEW: DESPL
    undo: "वापस लें", // REVIEW: DESPL
    tryAgain: "फिर कोशिश करें", // REVIEW: DESPL
    now: "अभी", // REVIEW: DESPL
    earlier: "पहले", // REVIEW: DESPL
    notDone: "नहीं हुआ", // REVIEW: DESPL
    notNow: "अभी नहीं", // REVIEW: DESPL
    optionalNote: "नोट जोड़ें (ज़रूरी नहीं)", // REVIEW: DESPL
  },
  outcome: {
    notSent: "भेजा नहीं गया", // REVIEW: DESPL
    noConnection: "कनेक्शन नहीं है। कुछ भी नहीं भेजा गया।", // REVIEW: DESPL
    signedOut: "फिर से साइन इन करें, फिर दोबारा कोशिश करें।", // REVIEW: DESPL
    signIn: "साइन इन", // REVIEW: DESPL
    otherUnitStep: "दूसरी यूनिट का स्टेप", // REVIEW: DESPL
    partial: (done, blocked) => `${done} पूरे · ${blocked} रुके हैं`, // REVIEW: DESPL
    recorded: (label) => `${label} — दर्ज हुआ`, // REVIEW: DESPL
    markedDone: (title, units) => `${title} पूरा हुआ${units > 1 ? ` (${units} यूनिट पर)` : ""}`, // REVIEW: DESPL
    sentToQc: (title, units) => `${title} QC को भेजा${units > 1 ? ` (${units} यूनिट पर)` : ""}`, // REVIEW: DESPL
    nudgeTold: (who) => `${who} को बता दिया गया है।`, // REVIEW: DESPL
    nudgeNobody: (who) => `${who} के लिए अभी कोई व्यक्ति तय नहीं है। प्रोडक्शन हेड से पूछें।`, // REVIEW: DESPL
    startedEarly: (title, units) => `${title} जल्दी शुरू किया${units > 1 ? ` (${units} यूनिट पर)` : ""}`, // REVIEW: DESPL
    started: (title, units) => `${title} शुरू किया${units > 1 ? ` (${units} यूनिट पर)` : ""}`, // REVIEW: DESPL
  },
  override: {
    MATERIAL_READY_EARLY: "माल या पार्ट जल्दी तैयार है", // REVIEW: DESPL
    CREW_OR_MACHINE_FREE: "टीम या मशीन खाली है, पिछला काम तैयार नहीं", // REVIEW: DESPL
    ACCESS_AVAILABLE_NOW: "क्रेन, पहुँच या जगह अभी उपलब्ध है", // REVIEW: DESPL
    CLIENT_PRIORITY: "क्लाइंट या डिलीवरी की प्राथमिकता", // REVIEW: DESPL
    OTHER: "अन्य", // REVIEW: DESPL
  },
  sheet: {
    titleDone: "काम पूरा हुआ", // REVIEW: DESPL
    titleStartEarly: "जल्दी शुरू करें", // REVIEW: DESPL
    titleStart: "शुरू करें", // REVIEW: DESPL
    whyNow: "अभी क्यों?", // REVIEW: DESPL
    sayWhyRequired: "कारण बताएँ (ज़रूरी)", // REVIEW: DESPL
    flagged: "यह प्रोडक्शन हेड को दिखाया जाएगा। किसी मंज़ूरी का इंतज़ार नहीं है।", // REVIEW: DESPL
    doneAt: "पूरा होने का समय", // REVIEW: DESPL
    startedAt: "शुरू होने का समय", // REVIEW: DESPL
    upToThreeDays: "आप 3 दिन पीछे तक दर्ज कर सकते हैं।", // REVIEW: DESPL
    welderFor: (joint) => `${joint} के लिए वेल्डर`, // REVIEW: DESPL
    pickWelderOption: "वेल्डर चुनें…", // REVIEW: DESPL
    alsoFor: (serials, n) => `${serials} के लिए भी${n > 0 ? ` (${n})` : ""}`, // REVIEW: DESPL
    clearAll: "सब हटाएँ", // REVIEW: DESPL
    selectAll: "सब चुनें", // REVIEW: DESPL
    inProgress: "चालू है", // REVIEW: DESPL
    notStarted: "शुरू नहीं हुआ", // REVIEW: DESPL
    lateRequired: "यह देर से है। किस वजह से रुका?", // REVIEW: DESPL
    lateOptional: "अगर इनमें से कोई देर से है, तो किस वजह से रुका?", // REVIEW: DESPL
    markDoneFor: (units) => `${units} यूनिट के लिए काम पूरा हुआ`, // REVIEW: DESPL
    startAndFlag: "शुरू करें और प्रोडक्शन हेड को बताएँ", // REVIEW: DESPL
    pickWelder: "वेल्डर चुनें", // REVIEW: DESPL
    pickHeldUp: "चुनें किस वजह से रुका", // REVIEW: DESPL
    pickWhyNow: "चुनें अभी क्यों", // REVIEW: DESPL
    sayWhy: "कारण बताएँ", // REVIEW: DESPL
    pickTime: "समय चुनें", // REVIEW: DESPL
  },
  floor: {
    nextFor: (depts) => `${depts} के अगले काम`, // REVIEW: DESPL
    nextAll: "अगले काम, सभी विभाग", // REVIEW: DESPL
    doneCount: (n) => ` · ${n} पूरे`, // REVIEW: DESPL
    nothingWaiting: "इस यूनिट पर आपके लिए कोई काम बाकी नहीं है।", // REVIEW: DESPL
    allDone: "यहाँ आपके विभाग का सब काम पूरा हो गया है।", // REVIEW: DESPL
    noneAssigned: "आपके विभाग को कोई स्टेप नहीं दिया गया है।", // REVIEW: DESPL
    showMore: (n) => `${n} और दिखाएँ`, // REVIEW: DESPL
    startedAt: (time) => ` · ${time} पर शुरू हुआ`, // REVIEW: DESPL
    alsoOnOthers: (n) => ` · ${n} और यूनिट पर भी`, // REVIEW: DESPL
    returnedByQc: (why) => `QC ने वापस भेजा${why ? `: ${why}` : ""}`, // REVIEW: DESPL
    needsReview: (rev) => `BOM${rev != null ? ` rev ${rev}` : ""} में बदला: प्लानर की समीक्षा का इंतज़ार`, // REVIEW: DESPL
  },
  today: {
    title: "आज", // REVIEW: DESPL
    summary: (assigned, attention, due, blocked) =>
      `${assigned} दिए गए · ${attention} पर ध्यान चाहिए · ${due} आज के · ${blocked} रुके हैं`, // REVIEW: DESPL
    checkInButton: "शिफ्ट के अंत की रिपोर्ट", // REVIEW: DESPL
    nothingAssigned: "आपको कोई काम नहीं दिया गया है।", // REVIEW: DESPL
    takeNext: "अपने विभाग का अगला काम लें।", // REVIEW: DESPL
    claimNext: "अगला काम लें", // REVIEW: DESPL
    claimed: "ले लिया। यह आपकी सूची में है।", // REVIEW: DESPL
    assignedHere: "आपको दिया गया काम यहाँ दिखेगा। बिना दिया हुआ काम नीचे के भाग में है।", // REVIEW: DESPL
    askSupervisorAssign: "अपने सुपरवाइज़र से काम देने को कहें।", // REVIEW: DESPL
    doFirst: "पहले यह करें", // REVIEW: DESPL
    todaySection: (n) => `आज · ${n}`, // REVIEW: DESPL
    blockedSection: (n) => `रुके हुए · ${n}`, // REVIEW: DESPL
    upcomingSection: (n) => `आने वाले · ${n}`, // REVIEW: DESPL
    showAll: (n) => `सभी ${n} दिखाएँ`, // REVIEW: DESPL
    unassigned: (n) => `आपके विभाग में ${n} काम किसी को नहीं दिए गए।`, // REVIEW: DESPL
    assignFromTeam: "टीम से काम दें", // REVIEW: DESPL
    myProgress: "मेरी प्रगति", // REVIEW: DESPL
    onTime30: "समय पर, पिछले 30 दिन:", // REVIEW: DESPL
    noData: "अभी डेटा नहीं", // REVIEW: DESPL
    doneThisWeek: "इस हफ़्ते पूरे:", // REVIEW: DESPL
    clearedToday: "आज निपटाए:", // REVIEW: DESPL
    overdueReason: "देर से · कारण चाहिए · ", // REVIEW: DESPL
    due: "तारीख",  // REVIEW: DESPL
    notScheduled: "तय नहीं", // REVIEW: DESPL
  },
  checkIn: {
    aria: "शिफ्ट के अंत की रिपोर्ट", // REVIEW: DESPL
    heading: "जाने से पहले — आज की योजना", // REVIEW: DESPL
    items: (n) => `${n} काम · जो आप पहले चिह्नित कर चुके हैं वह भरा हुआ है`, // REVIEW: DESPL
    doneToday: "आज पूरा हुआ", // REVIEW: DESPL
    heldUp: "किस वजह से रुका?", // REVIEW: DESPL
    noProcess: "कुछ कामों पर कारण दर्ज करने के लिए प्रोसेस नहीं है: वे जैसे हैं वैसे रहेंगे।", // REVIEW: DESPL
    nothingChanged: "कुछ नहीं बदला", // REVIEW: DESPL
    send: (n) => `${n} अपडेट भेजें`, // REVIEW: DESPL
    label: (done, held) => `${done} पूरे चिह्नित${held ? ` · ${held} रुके, कारण दर्ज` : ""}`, // REVIEW: DESPL
  },
};
