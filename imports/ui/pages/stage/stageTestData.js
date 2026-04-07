export const FAKE_PHONES = ["+33600000001", "+33600000002", "+33600000003", "+33600000004", "+33600000005", "+33600000006", "+33600000007", "+33600000008", "+33600000009", "+33600000010"]

export const FAKE_MESSAGES_DRAGUE = [
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "gagagag ag ag ag ag ag agag agag a blbfsl bhsfgl qbsgl bdfs gmqsb mdskfb mkqsbg mkqdsb miqubv mdwibv mdu bvmduv bwdmuv bmduv qervu wdmuv ndfwmkjvnwdmuv ndwmvun dwmjbndwml bj",
  "salut la régie",
  "on entend rien au fond",
  "c'est trop beau",
  "Hello Joaquim, J’ai passé une super soirée🔥 On pourrait refaire ça ?Je suis un dispo ce week-end, si jamais… Bise",
  "je comprends pas mais j'adore",
  "est-ce que quelqu'un a vu mon manteau",
  "il y a une douceur bizarre ici",
  "c'est a qui, ce silence ?",
  "je crois que je suis amoureux",
  "je crois que je suis amoureuse",
  "je voudrais que ca s'arrête mais pas maintenant",
  "quand j'étais petit je suis tombé amoureux d'une personne méchante",
  "si tu lis ca : je te reconnais",
  "J’espère que ce message n’arrive pas trop de nulle part, mais je pensais à toi.",
  "Je suis pas très fort(e) pour draguer, alors je vais juste dire que j’aimerais bien mieux te connaître.",
  "Tu me donnes un peu envie d’envoyer des messages alors que d’habitude je n’ose pas trop.",
  "Je voulais trouver un message intelligent, mais j’ai surtout juste envie de te dire bonsoir.",
  "Je sais pas si c’est maladroit, mais j’aime bien quand on parle tous les deux.",
  "Tfq ce soir ?",
  "glop"
]

export const FAKE_MESSAGES = FAKE_MESSAGES_DRAGUE

export const FAKE_MESSAGES_CHAUFFE = [
  "hello merci pour hier soir c'était trop beau j'ai le sourire aux levres depuis ce matin, j'aimerais beaucoup te revoir, n'hésite pas si tu as du temps dans les prochains jours",
  "hello suzanne quand est ce qu'on mange une crèpe suzette",
  "je préfère te le dire a l'oreille",
  "je vais te lécher l'oreille",
  "t'es aussi belle qu'un 🌴 ⭐️ 🛋️",
  "demain tout comme hier",
  "coucou ma puce ça fait longtemps je ne suis surtout pas en train de proposer de venir chez moi à 23h",
  "hello on va ensemble quelque part",
  "désolé marie mais au vu de la qualité de ta personne je suis obligé de te proposer de venir manger des tielles à mon domicile",
  "tu es très appétissante et je connais une bonne recette au bain maire",
  "j'ai envie d'enfouir mon visage en toi",
  "je reve de ta cambrure",
  "je suis tout émoustillé 💦💦💦💦💦💦💦",
  "coucou j'ai encore ton ordeur sur ma peau tu fais quoi demain",
  "je veux te sentir en moi",
  "Je pense à ton sexe si dur dans le mien trempé ça m’excite tellement",
  "je te lèche",
  "après cette derniere macaronade ensmeble j'ai encore le bon goût de tes brageoles on remet le couvert demain",
  "hello je sais pas draguer c'est pas mon fort mais une petite dance au dancing ça te dis?",
  "j'ai tellement envie de tes fesses",
  "tu sens la tielle de chez ciani j'ai envie de plonger dans ton poulpe",
  "j'aimerais me baigner dans tous tes liquides à tel point qu'il faudrait appeller les marins pompiers",
  "pas eu le temps de te faire à manger on rigolait hier avec les ocpains mais chaud de te faire ma meilleure putanesca",
  "t'es dispo ce week end pour un diner dans mon jardin je t'embrasse à tout vite",
  "envie de toi là maintenant tout de suite en drive en commande en uber en live en instantnté now smiley qui a chaud",
  "je ne sais jamais quoi écrire revoyons nous bientôt chauffe moi 0626707955",
]


export const FAKE_MESSAGES_INSULTE = [
  "vieille merde",
  "je ne t'aime plus mon amour",
  "gougnafié",
  "tu mériterais de sucer hitler",
  "espece de merde mégalomane qui se renifle constamment et reste dans son vieux jus nauséaux jusuq'a ses vieux jours de rancoeur",
  "chien de la casse",
  "t'es vraiment qu'une chienne",
  "déso j'ai toujours préféré ta soeur",
  "bonjour, le RN toujours aussi con plus envie de te voir mange tes morts",
  "sale pouple 🐙",
  "Je te déteste",
  "Va te faire brûler le cul sur un barbecue de bricorama",
]

export const FAKE_MESSAGE_SOURCES = {
  default: FAKE_MESSAGES_DRAGUE,
  drague: FAKE_MESSAGES_DRAGUE,
  chauffe: FAKE_MESSAGES_CHAUFFE,
  insulte: FAKE_MESSAGES_INSULTE,
}

function randomFrom(list) {
  return list[Math.floor(Math.random() * list.length)]
}

const fakeMessageCursorBySource = new Map()

function makeId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export function nextFakeMessageBody(sourceKey = "default") {
  const normalizedSourceKey = sourceKey in FAKE_MESSAGE_SOURCES ? sourceKey : "drague"
  const source = FAKE_MESSAGE_SOURCES[normalizedSourceKey] ?? FAKE_MESSAGES_DRAGUE
  if (!Array.isArray(source) || source.length === 0) {
    return ""
  }

  const currentIndex = fakeMessageCursorBySource.get(normalizedSourceKey) ?? 0
  const nextMessage = source[currentIndex % source.length]
  fakeMessageCursorBySource.set(normalizedSourceKey, currentIndex + 1)
  return nextMessage
}

export function makeFakeMessages(n, sourceKey = "default") {
  const count = Math.max(0, Number.parseInt(n, 10) || 0)

  return Array.from({ length: count }, () => ({
    id: makeId(),
    phone: randomFrom(FAKE_PHONES),
    body: nextFakeMessageBody(sourceKey),
    createdAt: Date.now(),
  }))
}
