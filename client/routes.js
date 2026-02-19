import { FlowRouter } from 'meteor/ostrio:flow-router-extra';

import './pages/stage.js';
import './pages/adminStage.js';

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
