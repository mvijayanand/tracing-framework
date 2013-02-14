/**
 * Copyright 2013 Google, Inc. All Rights Reserved.
 *
 * Use of this source code is governed by a BSD-style license that can be
 * found in the LICENSE file.
 */

/**
 * @fileoverview Event type definition table.
 *
 * @author benvanik@google.com (Ben Vanik)
 */

goog.provide('wtf.db.EventTypeTable');



/**
 * Event type definition table.
 * Provides management and lookup of event type definitions.
 *
 * @constructor
 */
wtf.db.EventTypeTable = function() {
  /**
   * The next ID to assign to a new event type.
   * 0 is reserved.
   * @type {number}
   * @private
   */
  this.nextTypeId_ = 1;

  /**
   * All event types, keyed by event ID.
   * @type {!Array.<!wtf.db.EventType>}
   * @private
   */
  this.eventsById_ = [];

  /**
   * All event types, mapped by name.
   * @type {!Object.<!wtf.db.EventType>}
   * @private
   */
  this.eventsByName_ = {};
};


/**
 * Adds an event type to the event table.
 * If the event type is already defined the existing one is returned. If any of
 * the values differ an error is thrown.
 * @param {!wtf.db.EventType} eventType Event type.
 * @return {!wtf.db.EventType} The given event type or an existing one.
 */
wtf.db.EventTypeTable.prototype.defineType = function(eventType) {
  var existingEventType = this.eventsByName_[eventType.name];
  if (!existingEventType) {
    eventType.id = this.nextTypeId_++;
    this.eventsById_[eventType.id] = eventType;
    this.eventsByName_[eventType.name] = eventType;
    return eventType;
  }

  // TODO(benvanik): diff definitions

  return existingEventType;
};


/**
 * Gets the event type for the given event ID.
 * @param {number} id Event ID.
 * @return {wtf.db.EventType?} Event type, if found.
 */
wtf.db.EventTypeTable.prototype.getById = function(id) {
  return this.eventsById_[id] || null;
};


/**
 * Gets the event type for the given event name.
 * @param {string} name Event name.
 * @return {wtf.db.EventType?} Event type, if found.
 */
wtf.db.EventTypeTable.prototype.getByName = function(name) {
  return this.eventsByName_[name] || null;
};


goog.exportSymbol(
    'wtf.db.EventTypeTable',
    wtf.db.EventTypeTable);
goog.exportProperty(
    wtf.db.EventTypeTable.prototype, 'getByName',
    wtf.db.EventTypeTable.prototype.getByName);
