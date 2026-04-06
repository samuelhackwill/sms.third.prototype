import { Meteor } from "meteor/meteor"
import { Template } from "meteor/templating"
import { ReactiveVar } from "meteor/reactive-var"

import { Messages } from "/imports/api/messages/messages"
import "/imports/ui/components/adminWallNav/adminWallNav.js"
import "./curation.html"

const BULK_ACTION_NONE = ""

function selectedIdSet(instance) {
  return new Set(instance.selectedMessageIds.get())
}

Template.CurationPage.onCreated(function onCreated() {
  this.selectedMessageIds = new ReactiveVar([])
  this.bulkAction = new ReactiveVar(BULK_ACTION_NONE)

  this.autorun(() => {
    this.subscribe("messages.all")
  })
})

Template.CurationPage.onRendered(function onRendered() {
  document.body.classList.add("admin-page")
})

Template.CurationPage.onDestroyed(function onDestroyed() {
  document.body.classList.remove("admin-page")
})

Template.CurationPage.helpers({
  messages() {
    const instance = Template.instance()
    const selectedIds = selectedIdSet(instance)

    return Messages.find({}, { sort: { receivedAt: -1, createdAt: -1 } }).map((message) => ({
      ...message,
      isSelected: selectedIds.has(message.id),
      receivedAtLabel: message.receivedAt instanceof Date ? message.receivedAt.toLocaleString() : "unknown",
    }))
  },
  messageCount() {
    return Messages.find().count()
  },
  selectedCount() {
    return Template.instance().selectedMessageIds.get().length
  },
  isBulkActionSelected(value) {
    return Template.instance().bulkAction.get() === value
  },
  statusEquals(left, right) {
    return left === right
  },
  hasMessages() {
    return Messages.find().count() > 0
  },
})

Template.CurationPage.events({
  'change [data-action="toggle-select"]'(event, instance) {
    const messageId = event.currentTarget.value
    const nextSelectedIds = selectedIdSet(instance)

    if (event.currentTarget.checked) {
      nextSelectedIds.add(messageId)
    } else {
      nextSelectedIds.delete(messageId)
    }

    instance.selectedMessageIds.set([...nextSelectedIds])
  },
  'change [data-action="select-all"]'(event, instance) {
    if (event.currentTarget.checked) {
      const allIds = Messages.find({}, { fields: { id: 1 } }).map((message) => message.id)
      instance.selectedMessageIds.set(allIds)
      return
    }

    instance.selectedMessageIds.set([])
  },
  'change [data-action="message-status"]'(event) {
    Meteor.call("messages.setStatus", {
      messageId: event.currentTarget.dataset.messageId,
      status: event.currentTarget.value,
    })
  },
  'click [data-action="delete-message"]'(event, instance) {
    event.preventDefault()
    const messageId = event.currentTarget.dataset.messageId

    Meteor.call("messages.remove", { messageId }, () => {
      instance.selectedMessageIds.set(
        instance.selectedMessageIds.get().filter((value) => value !== messageId),
      )
    })
  },
  'change [data-action="bulk-action"]'(event, instance) {
    instance.bulkAction.set(event.currentTarget.value || BULK_ACTION_NONE)
  },
  'click [data-action="apply-bulk-action"]'(event, instance) {
    event.preventDefault()

    const selectedIds = instance.selectedMessageIds.get()
    const bulkAction = instance.bulkAction.get()

    if (selectedIds.length === 0 || !bulkAction) {
      return
    }

    if (bulkAction === "delete") {
      Meteor.call("messages.removeMany", { messageIds: selectedIds }, () => {
        instance.selectedMessageIds.set([])
        instance.bulkAction.set(BULK_ACTION_NONE)
      })
      return
    }

    selectedIds.forEach((messageId) => {
      Meteor.call("messages.setStatus", {
        messageId,
        status: bulkAction,
      })
    })
  },
})
