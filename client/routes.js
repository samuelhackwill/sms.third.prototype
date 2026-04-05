import { FlowRouter } from 'meteor/ostrio:flow-router-extra';

import '/imports/ui/pages/stage/stage.js';
import '/imports/ui/pages/adminStage/adminStage.js';
import '/imports/ui/pages/curation/curation.js';
import '/imports/ui/pages/ticker/ticker.js';
import '/imports/ui/pages/adminTicker/adminTicker.js';
import '/imports/ui/pages/video/video.js';
import '/imports/ui/pages/adminVideo/adminVideo.js';
import '/imports/ui/pages/adminPush/adminPush.js';

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

FlowRouter.route('/curation', {
  name: 'curation',
  action() {
    this.render('CurationPage');
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

FlowRouter.route('/video', {
  name: 'video',
  action() {
    this.render('VideoPage');
  },
});

FlowRouter.route('/admin/video', {
  name: 'adminVideo',
  action() {
    this.render('AdminVideoPage');
  },
});

FlowRouter.route('/admin/push', {
  name: 'adminPush',
  action() {
    this.render('AdminPushPage');
  },
});
