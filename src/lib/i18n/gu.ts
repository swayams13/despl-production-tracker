// REVIEW: DESPL — every string below is a draft Gujarati translation for a native
// speaker on the floor to approve. Do not treat any of it as final.
import type { Dict } from "./en";

export const gu: Dict = {
  langName: "ગુજરાતી",
  intl: "gu-IN-u-nu-latn",
  state: {
    READY: "તૈયાર", // REVIEW: DESPL
    IN_PROGRESS: "ચાલુ છે", // REVIEW: DESPL
    WITH_QC: "QC પાસે", // REVIEW: DESPL
    QC_STEP: "QC ની રાહ", // REVIEW: DESPL
  },
  common: {
    start: "શરૂ કરો", // REVIEW: DESPL
    done: "થઈ ગયું", // REVIEW: DESPL
    markDone: "કામ પૂરું થયું", // REVIEW: DESPL
    startEarly: "વહેલું શરૂ કરો…", // REVIEW: DESPL
    cancel: "રદ કરો", // REVIEW: DESPL
    dismiss: "બંધ કરો", // REVIEW: DESPL
    tryAgain: "ફરી પ્રયત્ન કરો", // REVIEW: DESPL
    now: "હમણાં", // REVIEW: DESPL
    earlier: "પહેલાં", // REVIEW: DESPL
    notDone: "નથી થયું", // REVIEW: DESPL
    notNow: "હમણાં નહીં", // REVIEW: DESPL
    optionalNote: "નોંધ ઉમેરો (જરૂરી નથી)", // REVIEW: DESPL
  },
  outcome: {
    notSent: "મોકલાયું નથી", // REVIEW: DESPL
    noConnection: "કનેક્શન નથી. કંઈ મોકલાયું નથી.", // REVIEW: DESPL
    signedOut: "ફરીથી સાઇન ઇન કરો, પછી ફરી પ્રયાસ કરો.", // REVIEW: DESPL
    signIn: "સાઇન ઇન", // REVIEW: DESPL
    otherUnitStep: "બીજા યુનિટનું સ્ટેપ", // REVIEW: DESPL
    partial: (done, blocked) => `${done} પૂરા · ${blocked} અટક્યા`, // REVIEW: DESPL
    recorded: (label) => `${label} — નોંધાયું`, // REVIEW: DESPL
    markedDone: (title, units) => `${title} પૂરું થયું${units > 1 ? ` (${units} યુનિટ પર)` : ""}`, // REVIEW: DESPL
    sentToQc: (title, units) => `${title} QC ને મોકલ્યું${units > 1 ? ` (${units} યુનિટ પર)` : ""}`, // REVIEW: DESPL
    nudgeTold: (who) => `${who} ને જણાવી દીધું છે.`, // REVIEW: DESPL
    nudgeNobody: (who) => `${who} માટે હજી કોઈ નક્કી નથી. પ્રોડક્શન હેડને પૂછો.`, // REVIEW: DESPL
    startedEarly: (title, units) => `${title} વહેલું શરૂ કર્યું${units > 1 ? ` (${units} યુનિટ પર)` : ""}`, // REVIEW: DESPL
    started: (title, units) => `${title} શરૂ કર્યું${units > 1 ? ` (${units} યુનિટ પર)` : ""}`, // REVIEW: DESPL
  },
  override: {
    MATERIAL_READY_EARLY: "માલ અથવા પાર્ટ વહેલો તૈયાર છે", // REVIEW: DESPL
    CREW_OR_MACHINE_FREE: "ટીમ અથવા મશીન ખાલી છે, પહેલાંનું કામ તૈયાર નથી", // REVIEW: DESPL
    ACCESS_AVAILABLE_NOW: "ક્રેન, પહોંચ કે જગ્યા હમણાં ઉપલબ્ધ છે", // REVIEW: DESPL
    CLIENT_PRIORITY: "ક્લાયન્ટ અથવા ડિલિવરીની પ્રાથમિકતા", // REVIEW: DESPL
    OTHER: "અન્ય", // REVIEW: DESPL
  },
  sheet: {
    titleDone: "કામ પૂરું થયું", // REVIEW: DESPL
    titleStartEarly: "વહેલું શરૂ કરો", // REVIEW: DESPL
    titleStart: "શરૂ કરો", // REVIEW: DESPL
    whyNow: "હમણાં કેમ?", // REVIEW: DESPL
    sayWhyRequired: "કારણ જણાવો (જરૂરી)", // REVIEW: DESPL
    flagged: "આ પ્રોડક્શન હેડને બતાવવામાં આવશે. કોઈ મંજૂરીની રાહ નથી.", // REVIEW: DESPL
    doneAt: "પૂરું થયાનો સમય", // REVIEW: DESPL
    startedAt: "શરૂ થયાનો સમય", // REVIEW: DESPL
    upToThreeDays: "તમે 3 દિવસ પાછળ સુધી નોંધી શકો છો.", // REVIEW: DESPL
    welderFor: (joint) => `${joint} માટે વેલ્ડર`, // REVIEW: DESPL
    pickWelderOption: "વેલ્ડર પસંદ કરો…", // REVIEW: DESPL
    alsoFor: (serials, n) => `${serials} માટે પણ${n > 0 ? ` (${n})` : ""}`, // REVIEW: DESPL
    clearAll: "બધું કાઢો", // REVIEW: DESPL
    selectAll: "બધું પસંદ કરો", // REVIEW: DESPL
    inProgress: "ચાલુ છે", // REVIEW: DESPL
    notStarted: "શરૂ થયું નથી", // REVIEW: DESPL
    lateRequired: "આ મોડું છે. શું કારણથી અટક્યું?", // REVIEW: DESPL
    lateOptional: "જો આમાંથી કોઈ મોડું હોય, તો શું કારણથી અટક્યું?", // REVIEW: DESPL
    markDoneFor: (units) => `${units} યુનિટ માટે કામ પૂરું થયું`, // REVIEW: DESPL
    startAndFlag: "શરૂ કરો અને પ્રોડક્શન હેડને જણાવો", // REVIEW: DESPL
    pickWelder: "વેલ્ડર પસંદ કરો", // REVIEW: DESPL
    pickHeldUp: "પસંદ કરો શું કારણથી અટક્યું", // REVIEW: DESPL
    pickWhyNow: "પસંદ કરો હમણાં કેમ", // REVIEW: DESPL
    sayWhy: "કારણ જણાવો", // REVIEW: DESPL
    pickTime: "સમય પસંદ કરો", // REVIEW: DESPL
  },
  floor: {
    nextFor: (depts) => `${depts} માટે આગળનું કામ`, // REVIEW: DESPL
    nextAll: "આગળનું કામ, બધા વિભાગ", // REVIEW: DESPL
    doneCount: (n) => ` · ${n} પૂરા`, // REVIEW: DESPL
    nothingWaiting: "આ યુનિટ પર તમારા માટે કોઈ કામ બાકી નથી.", // REVIEW: DESPL
    allDone: "અહીં તમારા વિભાગનું બધું કામ પૂરું થઈ ગયું છે.", // REVIEW: DESPL
    noneAssigned: "તમારા વિભાગને કોઈ સ્ટેપ સોંપાયું નથી.", // REVIEW: DESPL
    showMore: (n) => `વધુ ${n} બતાવો`, // REVIEW: DESPL
    startedAt: (time) => ` · ${time} વાગ્યે શરૂ થયું`, // REVIEW: DESPL
    alsoOnOthers: (n) => ` · બીજા ${n} યુનિટ પર પણ`, // REVIEW: DESPL
    returnedByQc: (why) => `QC એ પાછું મોકલ્યું${why ? `: ${why}` : ""}`, // REVIEW: DESPL
    needsReview: (rev) => `BOM${rev != null ? ` rev ${rev}` : ""} માં બદલાયું: પ્લાનરની સમીક્ષાની રાહ`, // REVIEW: DESPL
  },
  today: {
    title: "આજે", // REVIEW: DESPL
    summary: (assigned, attention, due, blocked) =>
      `${assigned} સોંપાયા · ${attention} પર ધ્યાન જોઈએ · ${due} આજના · ${blocked} અટક્યા`, // REVIEW: DESPL
    checkInButton: "શિફ્ટના અંતનો રિપોર્ટ", // REVIEW: DESPL
    nothingAssigned: "તમને કોઈ કામ સોંપાયું નથી.", // REVIEW: DESPL
    takeNext: "તમારા વિભાગનું આગળનું કામ લો.", // REVIEW: DESPL
    claimNext: "આગળનું કામ લો", // REVIEW: DESPL
    claimed: "લઈ લીધું. તે તમારી યાદીમાં છે.", // REVIEW: DESPL
    assignedHere: "તમને સોંપાયેલું કામ અહીં દેખાશે. ન સોંપાયેલું કામ નીચેના ભાગમાં છે.", // REVIEW: DESPL
    askSupervisorAssign: "તમારા સુપરવાઇઝરને કામ સોંપવા કહો.", // REVIEW: DESPL
    doFirst: "પહેલાં આ કરો", // REVIEW: DESPL
    todaySection: (n) => `આજે · ${n}`, // REVIEW: DESPL
    blockedSection: (n) => `અટકેલા · ${n}`, // REVIEW: DESPL
    upcomingSection: (n) => `આવનારા · ${n}`, // REVIEW: DESPL
    showAll: (n) => `બધા ${n} બતાવો`, // REVIEW: DESPL
    unassigned: (n) => `તમારા વિભાગમાં ${n} કામ કોઈને સોંપાયા નથી.`, // REVIEW: DESPL
    assignFromTeam: "ટીમમાંથી કામ સોંપો", // REVIEW: DESPL
    myProgress: "મારી પ્રગતિ", // REVIEW: DESPL
    onTime30: "સમયસર, છેલ્લા 30 દિવસ:", // REVIEW: DESPL
    noData: "હજી ડેટા નથી", // REVIEW: DESPL
    doneThisWeek: "આ અઠવાડિયે પૂરા:", // REVIEW: DESPL
    clearedToday: "આજે પતાવ્યા:", // REVIEW: DESPL
    overdueReason: "મોડું · કારણ જોઈએ · ", // REVIEW: DESPL
    due: "તારીખ", // REVIEW: DESPL
    notScheduled: "નક્કી નથી", // REVIEW: DESPL
  },
  checkIn: {
    aria: "શિફ્ટના અંતનો રિપોર્ટ", // REVIEW: DESPL
    heading: "જતાં પહેલાં — આજની યોજના", // REVIEW: DESPL
    items: (n) => `${n} કામ · તમે પહેલાં જે ચિહ્નિત કર્યું તે ભરેલું છે`, // REVIEW: DESPL
    doneToday: "આજે પૂરું થયું", // REVIEW: DESPL
    heldUp: "શું કારણથી અટક્યું?", // REVIEW: DESPL
    noProcess: "કેટલાક કામ પર કારણ નોંધવા માટે પ્રોસેસ નથી: તે જેમ છે તેમ રહેશે.", // REVIEW: DESPL
    nothingChanged: "કંઈ બદલાયું નથી", // REVIEW: DESPL
    send: (n) => `${n} અપડેટ મોકલો`, // REVIEW: DESPL
    label: (done, held) => `${done} પૂરા ચિહ્નિત${held ? ` · ${held} અટક્યા, કારણ નોંધ્યું` : ""}`, // REVIEW: DESPL
  },
};
