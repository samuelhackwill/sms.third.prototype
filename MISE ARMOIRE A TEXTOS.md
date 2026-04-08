## MISE ARMOIRE A TEXTOS
autrement appellé "la vache à Tim"

### montage de l'étagère
- [ ] monter l'étagère (30 écrous environ) en portant des gants (*attention c'est coupant*)

attention à pas trop serrer les écrous des mangeoires à téléphones (ça plie les montants sur lesquelles elles sont visées)

quand au reste, ne pas avoir peur de bien serrer pour donner de la rigidité

les pièces d'apparence identique ne sont pas interchangeables donc si ça s'aligne mal jeter ou coup d'oeil au plan (les pièces sont numérotées).

### branchements
- [ ] brancher RJ45 internet sur l'entrée WAN du routeur unifi dans l'étagère (logo globe terrestre bleu)

- [ ] brancher RJ45 LAN sur l'autre entrée du routeur dans l'étagère brancher l'autre extremité sur le switch en régie

- [ ] brancher électriquement l'étagère. Attendre que le routeur unifi boote. si tout se passe bien avec internet le switch n'affichera pas "no internet detected contact your isp" (sinon voir avec le théâtre)

- [ ] brancher le switch régie sur le mac mini et sur le routeur 4G tenda en plastique noir avec des antennes

### lanchement de la webapp

- [ ] allumer le mac mini

login (mdp : rolandBarthes)

- [ ] ouvrir un terminal et y entrer
```
cd ~/htdocs/sms.third.prototype && meteor --settings settings.json
```

- [ ] allumer les téléphones (y'a pas de mot de passe)

ne pas faire de mise à jour si les téléphones le demandent

- [ ] aller sur http://localhost:3000/ sur le mac mini dans chrome

- [ ] là il faut que le routeur tenda avec les antennes soit reachable à l'adresse 10.73.73.5 (le routeur est uniquement utilisé en cas de problème avec imessages, voir plus bas)

si c'est pas le cas c'est qu'il y a un problème avec le réseau, appeler Samuel. y'a peut être un conflit IP avec une autre machine sur le réseau, ou alors le routeur est sur un autre plage d'adresses somehow.

### prépa des téléphones

prendre en photo le QR code avec un smartphone ou l'imprimer

ouvrir ce qr code avec les iphones de l'étagère un à un

- [ ] normalement tous les téléphones ont maintenant leur navigateur web ouvert à la bonne adresse (on voit un fond noir)

### test

envoyer un texto à 06 21 65 65 43

- [ ] le texto devrait apparaître sur la première rangée des téléphones.