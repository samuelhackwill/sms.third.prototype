import { FlowRouter } from 'meteor/ostrio:flow-router-extra';

import '/imports/ui/pages/stage/stage.js';
import '/imports/ui/pages/adminStage/adminStage.js';
import '/imports/ui/pages/ticker/ticker.js';
import '/imports/ui/pages/adminTicker/adminTicker.js';

FlowRouter.route('/', {
  name: 'home',
  action() {
    this.render('home');
  },
});

FlowRouter.route('/stage', {
  name: 'stage',
  action() {
    this.render('stage');
  },
});

FlowRouter.route('/admin/stage', {
  name: 'adminStage',
  action() {
    this.render('adminStage');
  },
});

FlowRouter.route('/ticker', {
  name: 'ticker',
  action() {
    this.render('TickerPage');
  },
});

FlowRouter.route('/admin/ticker', {
  name: 'adminTicker',
  action() {
    this.render('AdminTickerPage');
  },
});
