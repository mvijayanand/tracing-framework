/**
 * Copyright 2013 Google, Inc. All Rights Reserved.
 *
 * Use of this source code is governed by a BSD-style license that can be
 * found in the LICENSE file.
 */

/**
 * @fileoverview Event statistics table.
 *
 * @author benvanik@google.com (Ben Vanik)
 */

goog.provide('wtf.db.EventDataEntry');
goog.provide('wtf.db.EventStatistics');
goog.provide('wtf.db.InstanceEventDataEntry');
goog.provide('wtf.db.ScopeEventDataEntry');
goog.provide('wtf.db.SortMode');

goog.require('goog.Disposable');
goog.require('goog.object');
goog.require('wtf.data.EventClass');
goog.require('wtf.data.EventFlag');


/**
 * Sorting mode to use when retrieving entries.
 * @enum {number}
 */
wtf.db.SortMode = {
  ANY: 0,
  COUNT: 1,
  TOTAL_TIME: 2,
  MEAN_TIME: 3
};


goog.exportSymbol(
    'wtf.db.SortMode',
    wtf.db.SortMode);
goog.exportProperty(
    wtf.db.SortMode, 'ANY',
    wtf.db.SortMode.ANY);
goog.exportProperty(
    wtf.db.SortMode, 'COUNT',
    wtf.db.SortMode.COUNT);
goog.exportProperty(
    wtf.db.SortMode, 'TOTAL_TIME',
    wtf.db.SortMode.TOTAL_TIME);
goog.exportProperty(
    wtf.db.SortMode, 'MEAN_TIME',
    wtf.db.SortMode.MEAN_TIME);



/**
 * Event data table.
 * Caches detailed aggregate information about events.
 *
 * @param {!wtf.db.Database} db Event database.
 * @param {?wtf.db.FilterFunction=} opt_filter Initial filter.
 * @constructor
 * @extends {goog.Disposable}
 */
wtf.db.EventStatistics = function(db, opt_filter) {
  goog.base(this);

  /**
   * Event database.
   * @type {!wtf.db.Database}
   * @private
   */
  this.db_ = db;

  /**
   * Event data keyed on event name.
   * @type {!Object.<!wtf.db.EventDataEntry>}
   * @private
   */
  this.table_ = {};

  /**
   * All event data entries as objects keyed by event type name.
   * @type {!Object.<wtf.data.EventClass, !Object.<!wtf.db.EventDataEntry>>}
   * @private
   */
  this.entriesByClass_ = {};
  this.entriesByClass_[wtf.data.EventClass.INSTANCE] = {};
  this.entriesByClass_[wtf.data.EventClass.SCOPE] = {};

  /**
   * A list of all event entries.
   * @type {!Array.<!wtf.db.EventDataEntry>}
   * @private
   */
  this.list_ = [];

  /**
   * The current sort mode of the list.
   * This is used to prevent successive sorts of the list.
   * @type {wtf.db.SortMode}
   * @private
   */
  this.listSortMode_ = wtf.db.SortMode.ANY;

  /**
   * Total number of filtered events.
   * @type {number}
   * @private
   */
  this.filteredEventCount_ = 0;

  this.rebuild(Number.MIN_VALUE, Number.MAX_VALUE, opt_filter);
};
goog.inherits(wtf.db.EventStatistics, goog.Disposable);


/**
 * Rebuilds the event data table.
 * @param {number} startTime Starting time.
 * @param {number} endTime Ending time.
 * @param {?wtf.db.FilterFunction=} opt_filter Event filter.
 */
wtf.db.EventStatistics.prototype.rebuild = function(
    startTime, endTime, opt_filter) {
  // TODO(benvanik): cache? etc?
  var tableById = {};
  var list = [];
  this.filteredEventCount_ = 0;

  var scopeEntries = {};
  this.entriesByClass_[wtf.data.EventClass.SCOPE] = scopeEntries;
  var instanceEntries = {};
  this.entriesByClass_[wtf.data.EventClass.INSTANCE] = instanceEntries;

  var eventTypeTable = this.db_.getEventTypeTable();
  var zones = this.db_.getZones();
  for (var n = 0; n < zones.length; n++) {
    var eventList = zones[n].getEventList();
    var it = eventList.beginTimeRange(startTime, endTime);
    while (!it.done()) {
      // Skip system events/etc.
      var type = it.getType();
      if (type.flags & wtf.data.EventFlag.INTERNAL ||
          type.flags & wtf.data.EventFlag.BUILTIN) {
        it.next();
        continue;
      }

      // Ignore the event if it doesn't match.
      if (opt_filter && !opt_filter(it)) {
        it.next();
        continue;
      }

      var entry = tableById[type.id];
      if (!entry) {
        if (it.isScope()) {
          entry = new wtf.db.ScopeEventDataEntry(type);
          scopeEntries[type.name] = entry;
        } else {
          entry = new wtf.db.InstanceEventDataEntry(type);
          instanceEntries[type.name] = entry;
        }
        tableById[type.id] = entry;
        list.push(entry);
      }
      entry.appendEvent(it);
      this.filteredEventCount_++;

      it.next();
    }
  }

  // Build a table by type name.
  var tableByName = {};
  for (var n = 0; n < list.length; n++) {
    tableByName[list[n].name] = list[n];
  }

  this.table_ = tableByName;
  this.list_ = list;
  this.listSortMode_ = wtf.db.SortMode.ANY;
};


/**
 * Gets the total number of events included in the table.
 * @return {number} Event count.
 */
wtf.db.EventStatistics.prototype.getFilteredEventCount = function() {
  return this.filteredEventCount_;
};


/**
 * Gets the entry for an event type, if it exists.
 * @param {string} eventName Event name.
 * @return {wtf.db.EventDataEntry} Event entry, if it exists.
 */
wtf.db.EventStatistics.prototype.getEventTypeEntry = function(eventName) {
  return this.table_[eventName] || null;
};


/**
 * Gets all entries from the table of the given type.
 * @param {wtf.data.EventClass} eventClass Event class.
 * @return {!Object.<!wtf.db.EventDataEntry>} All entries of the given
 *     class, keyed by event type name.
 */
wtf.db.EventStatistics.prototype.getEntriesByClass =
    function(eventClass) {
  return this.entriesByClass_[eventClass];
};


/**
 * Enumerates all event type entries in the data table.
 * @param {function(this: T, !wtf.db.EventDataEntry)} callback
 *     A function called for each entry.
 * @param {T=} opt_scope Callback scope.
 * @param {wtf.db.SortMode=} opt_sortMode Sort mode.
 * @template T
 */
wtf.db.EventStatistics.prototype.forEach = function(
    callback, opt_scope, opt_sortMode) {
  if (opt_sortMode && this.listSortMode_ != opt_sortMode) {
    // Sort before enumerating if the sort order does not match the cached
    // value.
    this.listSortMode_ = opt_sortMode;
    switch (this.listSortMode_) {
      case wtf.db.SortMode.COUNT:
        this.list_.sort(function(a, b) {
          return b.count - a.count;
        });
        break;
      case wtf.db.SortMode.TOTAL_TIME:
        this.list_.sort(function(a, b) {
          if (a instanceof wtf.db.ScopeEventDataEntry &&
              b instanceof wtf.db.ScopeEventDataEntry) {
            return b.totalTime_ - a.totalTime_;
          } else if (a instanceof wtf.db.ScopeEventDataEntry) {
            return -1;
          } else if (b instanceof wtf.db.ScopeEventDataEntry) {
            return 1;
          } else {
            return b.count - a.count;
          }
        });
        break;
      case wtf.db.SortMode.MEAN_TIME:
        this.list_.sort(function(a, b) {
          if (a instanceof wtf.db.ScopeEventDataEntry &&
              b instanceof wtf.db.ScopeEventDataEntry) {
            return b.getMeanTime() - a.getMeanTime();
          } else if (a instanceof wtf.db.ScopeEventDataEntry) {
            return -1;
          } else if (b instanceof wtf.db.ScopeEventDataEntry) {
            return 1;
          } else {
            return b.count - a.count;
          }
        });
        break;
    }
  }
  for (var n = 0; n < this.list_.length; n++) {
    callback.call(opt_scope, this.list_[n]);
  }
};


/**
 * Gets all of the event type names found in all of the given tables.
 * @param {!Array.<!wtf.db.EventStatistics>} tables Tables.
 * @param {wtf.data.EventClass=} opt_eventClass Class to limit to.
 * @return {!Array.<string>} All event type names.
 */
wtf.db.EventStatistics.getAllEventTypeNames = function(tables, opt_eventClass) {
  var names = {};
  for (var n = 0; n < tables.length; n++) {
    var table = tables[n];
    for (var m = 0; m < table.list_.length; m++) {
      var eventType = table.list_[m].eventType;
      if (opt_eventClass === undefined ||
          eventType.eventClass == opt_eventClass) {
        names[eventType.name] = true;
      }
    }
  }
  return goog.object.getKeys(names);
};


goog.exportSymbol(
    'wtf.db.EventStatistics',
    wtf.db.EventStatistics);
goog.exportProperty(
    wtf.db.EventStatistics.prototype, 'rebuild',
    wtf.db.EventStatistics.prototype.rebuild);
goog.exportProperty(
    wtf.db.EventStatistics.prototype, 'getFilteredEventCount',
    wtf.db.EventStatistics.prototype.getFilteredEventCount);
goog.exportProperty(
    wtf.db.EventStatistics.prototype, 'getEventTypeEntry',
    wtf.db.EventStatistics.prototype.getEventTypeEntry);
goog.exportProperty(
    wtf.db.EventStatistics.prototype, 'getEntriesByClass',
    wtf.db.EventStatistics.prototype.getEntriesByClass);
goog.exportProperty(
    wtf.db.EventStatistics.prototype, 'forEach',
    wtf.db.EventStatistics.prototype.forEach);
goog.exportSymbol(
    'wtf.db.EventStatistics.getAllEventTypeNames',
    wtf.db.EventStatistics.getAllEventTypeNames);



/**
 * Abstract base type for entries in the {@see wtf.db.EventStatistics}.
 * @param {!wtf.db.EventType} eventType Event type.
 * @constructor
 */
wtf.db.EventDataEntry = function(eventType) {
  /**
   * Event type.
   * @type {!wtf.db.EventType}
   * @protected
   */
  this.eventType = eventType;

  /**
   * Total number of the events encountered.
   * @type {number}
   * @protected
   */
  this.count = 0;
};


/**
 * Appends an event to the entry.
 * @param {!wtf.db.EventIterator} it Event.
 */
wtf.db.EventDataEntry.prototype.appendEvent = goog.abstractMethod;


/**
 * Gets the event type this entry describes.
 * @return {!wtf.db.EventType} Event type.
 */
wtf.db.EventDataEntry.prototype.getEventType = function() {
  return this.eventType;
};


/**
 * Gets the total number of events encountered.
 * @return {number} Event count.
 */
wtf.db.EventDataEntry.prototype.getCount = function() {
  return this.count;
};


/**
 * Gets the frequency of the events as a measure of instances/sec.
 * @return {number} Instances/second.
 */
wtf.db.EventDataEntry.prototype.getFrequency = function() {
  // TODO(benvanik): compute frequency of events.
  return 0;
};


goog.exportSymbol(
    'wtf.db.EventDataEntry',
    wtf.db.EventDataEntry);
goog.exportProperty(
    wtf.db.EventDataEntry.prototype, 'getEventType',
    wtf.db.EventDataEntry.prototype.getEventType);
goog.exportProperty(
    wtf.db.EventDataEntry.prototype, 'getCount',
    wtf.db.EventDataEntry.prototype.getCount);
goog.exportProperty(
    wtf.db.EventDataEntry.prototype, 'getFrequency',
    wtf.db.EventDataEntry.prototype.getFrequency);



/**
 * An entry in the {@see wtf.db.EventStatistics} describing scope
 * event types.
 * @param {!wtf.db.EventType} eventType Event type.
 * @constructor
 * @extends {wtf.db.EventDataEntry}
 */
wtf.db.ScopeEventDataEntry = function(eventType) {
  goog.base(this, eventType);

  /**
   * Total time taken by all scopes.
   * @type {number}
   * @private
   */
  this.totalTime_ = 0;

  /**
   * Total time taken by all scopes, minus system time.
   * @type {number}
   * @private
   */
  this.userTime_ = 0;

  /**
   * Buckets of time, each 1ms.
   * @type {!Uint32Array}
   * @private
   */
  this.buckets_ = new Uint32Array(1000);
};
goog.inherits(wtf.db.ScopeEventDataEntry, wtf.db.EventDataEntry);


/**
 * @override
 */
wtf.db.ScopeEventDataEntry.prototype.appendEvent = function(it) {
  this.count++;

  var userDuration = it.getUserDuration();
  this.totalTime_ += it.getTotalDuration();
  this.userTime_ += userDuration;

  var bucketIndex = Math.round(userDuration) | 0;
  if (bucketIndex >= 1000) {
    bucketIndex = 999;
  }
  this.buckets_[bucketIndex]++;
};


/**
 * Gets the total time spent within all scopes of this type, including
 * system time.
 * @return {number} Total time.
 */
wtf.db.ScopeEventDataEntry.prototype.getTotalTime = function() {
  return this.totalTime_;
};


/**
 * Gets the total time spent within all scopes of this type, excluding
 * system time.
 * @return {number} Total time.
 */
wtf.db.ScopeEventDataEntry.prototype.getUserTime = function() {
  return this.userTime_;
};


/**
 * Gets the mean time of scopes of this type.
 * @return {number} Average mean time.
 */
wtf.db.ScopeEventDataEntry.prototype.getMeanTime = function() {
  if (this.count) {
    if (this.eventType.flags & wtf.data.EventFlag.SYSTEM_TIME) {
      return this.totalTime_ / this.count;
    } else {
      return this.userTime_ / this.count;
    }
  } else {
    return 0;
  }
};


/**
 * Gets the distribution of the events over 0-1s.
 * Any event that ran longer than 1s will be in the last bucket.
 * @return {!Uint32Array} Distribution.
 */
wtf.db.ScopeEventDataEntry.prototype.getDistribution = function() {
  return this.buckets_;
};


goog.exportSymbol(
    'wtf.db.ScopeEventDataEntry',
    wtf.db.ScopeEventDataEntry);
goog.exportProperty(
    wtf.db.ScopeEventDataEntry.prototype, 'getTotalTime',
    wtf.db.ScopeEventDataEntry.prototype.getTotalTime);
goog.exportProperty(
    wtf.db.ScopeEventDataEntry.prototype, 'getUserTime',
    wtf.db.ScopeEventDataEntry.prototype.getUserTime);
goog.exportProperty(
    wtf.db.ScopeEventDataEntry.prototype, 'getMeanTime',
    wtf.db.ScopeEventDataEntry.prototype.getMeanTime);
goog.exportProperty(
    wtf.db.ScopeEventDataEntry.prototype, 'getDistribution',
    wtf.db.ScopeEventDataEntry.prototype.getDistribution);



/**
 * An entry in the {@see wtf.db.EventStatistics} describing instance
 * event types.
 * @param {!wtf.db.EventType} eventType Event type.
 * @constructor
 * @extends {wtf.db.EventDataEntry}
 */
wtf.db.InstanceEventDataEntry = function(eventType) {
  goog.base(this, eventType);
};
goog.inherits(wtf.db.InstanceEventDataEntry, wtf.db.EventDataEntry);


/**
 * @override
 */
wtf.db.InstanceEventDataEntry.prototype.appendEvent = function(it) {
  this.count++;
};


goog.exportSymbol(
    'wtf.db.InstanceEventDataEntry',
    wtf.db.InstanceEventDataEntry);
