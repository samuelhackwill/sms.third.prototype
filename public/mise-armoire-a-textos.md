## MISE ARMOIRE A TEXTOS
autrement appelle "la vache a Tim"

### montage de l'etagere
- [ ] monter l'etagere (30 ecrous environ) en portant des gants (*attention c'est coupant*)

attention a pas trop serrer les ecrous des mangeoires a telephones (ca plie les montants sur lesquelles elles sont visees)

quand au reste, ne pas avoir peur de bien serrer pour donner de la rigidite

les pieces d'apparence identique ne sont pas interchangeables donc si ca s'aligne mal jeter ou coup d'oeil au plan (les pieces sont numerotees).

### branchements
- [ ] brancher RJ45 internet sur l'entree WAN du routeur unifi dans l'etagere (logo globe terrestre bleu)

- [ ] brancher RJ45 LAN sur l'autre entree du routeur dans l'etagere brancher l'autre extremite sur le switch en regie

- [ ] brancher electriquement l'etagere. Attendre que le routeur unifi boote. si tout se passe bien avec internet le switch n'affichera pas "no internet detected contact your isp" (sinon voir avec le theatre)

- [ ] brancher le switch regie sur le mac mini et sur le routeur 4G tenda en plastique noir avec des antennes

### lanchement de la webapp

- [ ] allumer le mac mini

login (mdp : rolandBarthes)

- [ ] ouvrir un terminal et y entrer
```
cd ~/htdocs/sms.third.prototype && meteor --settings settings.json
```

- [ ] allumer les telephones (y'a pas de mot de passe)

ne pas faire de mise a jour si les telephones le demandent

- [ ] aller sur http://localhost:3000/ sur le mac mini dans chrome

- [ ] la il faut que le routeur tenda avec les antennes soit reachable a l'adresse 10.73.73.5 (le routeur est uniquement utilise en cas de probleme avec imessages, voir plus bas)

si c'est pas le cas c'est qu'il y a un probleme avec le reseau, appeler Samuel. y'a peut etre un conflit IP avec une autre machine sur le reseau, ou alors le routeur est sur un autre plage d'adresses somehow.

### prepa des telephones

prendre en photo le QR code avec un smartphone ou l'imprimer

ouvrir ce qr code avec les iphones de l'etagere un a un

- [ ] normalement tous les telephones ont maintenant leur navigateur web ouvert a la bonne adresse (on voit un fond noir)

### test

envoyer un texto a 06 21 65 65 43

- [ ] le texto devrait apparaitre sur la premiere rangee des telephones.
