export const FAKE_PHONES = ["+33600000001", "+33600000002", "+33600000003", "+33600000004", "+33600000005", "+33600000006", "+33600000007", "+33600000008", "+33600000009", "+33600000010"]

export const FAKE_MESSAGES = [
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "gagagag ag ag ag ag ag agag agag a blbfsl bhsfgl qbsgl bdfs gmqsb mdskfb mkqsbg mkqdsb miqubv mdwibv mdu bvmduv bwdmuv bmduv qervu wdmuv ndfwmkjvnwdmuv ndwmvun dwmjbndwml bj",
  "salut la régie",
  "on entend rien au fond",
  "c'est trop beau",
  "je comprends pas mais j'adore",
  "est-ce que quelqu'un a vu mon manteau",
  "il y a une douceur bizarre ici",
  "c'est a qui, ce silence ?",
  "je crois que je suis amoureux",
  "je crois que je suis amoureuse",
  "je voudrais que ca s'arrête mais pas maintenant",
  "quand j'étais petit je suis tombé amoureux d'une personne méchante",
  "si tu lis ca : je te reconnais",
  "j'écris pour verifier que je suis encore vivant",
]

function randomFrom(list) {
  return list[Math.floor(Math.random() * list.length)]
}

function makeId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export function makeFakeMessages(n) {
  const count = Math.max(0, Number.parseInt(n, 10) || 0)

  return Array.from({ length: count }, () => ({
    id: makeId(),
    phone: randomFrom(FAKE_PHONES),
    body: randomFrom(FAKE_MESSAGES),
    createdAt: Date.now(),
  }))
}
