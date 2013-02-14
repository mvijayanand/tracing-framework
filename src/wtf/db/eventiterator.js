/**
 * Copyright 2013 Google, Inc. All Rights Reserved.
 *
 * Use of this source code is governed by a BSD-style license that can be
 * found in the LICENSE file.
 */

/**
 * @fileoverview Event iterator.
 *
 * @author benvanik@google.com (Ben Vanik)
 */

goog.provide('wtf.db.EventIterator');
goog.provide('wtf.db.EventList');
goog.provide('wtf.db.IAncillaryList');

goog.require('goog.array');
goog.require('wtf.data.EventClass');
goog.require('wtf.data.EventFlag');
goog.require('wtf.db.EventStruct');
goog.require('wtf.db.EventType');
goog.require('wtf.util');



/**
 * @interface
 */
wtf.db.IAncillaryList = function() {};


/**
 * Begins a rebuild operation.
 * The list of returned event types is used to decide what events are dispatched
 * to the handler routine.
 * @param {!wtf.db.EventTypeTable} eventTypeTable Event type table.
 * @return {!Array.<!wtf.db.EventType>} Event types to handle.
 */
wtf.db.IAncillaryList.prototype.beginRebuild = goog.nullFunction;


/**
 * Handles an event that had its type registered.
 * @param {number} eventTypeIndex Index into the event type list returned from
 *     {@see #beginRebuild}.
 * @param {!wtf.db.EventType} eventType Event type.
 * @param {!wtf.db.EventIterator} it Event iterator.
 */
wtf.db.IAncillaryList.prototype.handleEvent = goog.nullFunction;


/**
 * Ends the current rebuild operation.
 */
wtf.db.IAncillaryList.prototype.endRebuild = goog.nullFunction;



/**
 * Event data list.
 *
 * @param {!wtf.db.EventTypeTable} eventTypeTable Event type table.
 * @constructor
 */
wtf.db.EventList = function(eventTypeTable) {
  /**
   * Event type table.
   * @type {!wtf.db.EventTypeTable}
   */
  this.eventTypeTable = eventTypeTable;

  /**
   * Ancillary lists, in the order they were registered.
   * @type {!Array.<!wtf.db.IAncillaryList>}
   * @private
   */
  this.ancillaryLists_ = [];

  /**
   * Total number of events stored in the backing buffer.
   * @type {number}
   */
  this.count = 0;

  /**
   * Current capacity of the event data backing buffer.
   * @type {number}
   * @private
   */
  this.capacity_ = 0;

  /**
   * Event data.
   * This will be recreated many times, so do not hang on to references outside
   * of function scopes.
   * @type {!Uint32Array}
   */
  this.eventData = new Uint32Array(0);

  /**
   * Argument data hash.
   * Index 0 is reserved.
   * @type {!Array.<!wtf.db.ArgumentData>}
   */
  this.argumentData_ = [null];

  /**
   * The next ID to assign to inserted argument data.
   * @type {number}
   * @private
   */
  this.nextArgumentDataId_ = 1;

  /**
   * First event time, if any.
   * @type {number}
   * @private
   */
  this.firstEventTime_ = 0;

  /**
   * Last event time, if any.
   * @type {number}
   * @private
   */
  this.lastEventTime_ = 0;

  /**
   * Maximum scope depth.
   * @type {number}
   * @private
   */
  this.maximumScopeDepth_ = 0;
};


/**
 * Registers an ancillary list that will be updated after event batches.
 * This does not take ownership of the list and it must be disposed elsewhere.
 * @param {!wtf.db.IAncillaryList} value Ancillary list.
 */
wtf.db.EventList.prototype.registerAncillaryList = function(value) {
  this.ancillaryLists_.push(value);
  if (this.count) {
    // NOTE: this is inefficient but will only trigger if there's already data
    // in the database.
    this.rebuildAncillaryLists_([value]);
  }
};


/**
 * Unregisters an ancillary list that will be updated after event batches.
 * @param {!wtf.db.IAncillaryList} value Ancillary list.
 */
wtf.db.EventList.prototype.unregisterAncillaryList = function(value) {
  goog.array.remove(this.ancillaryLists_, value);
};


/**
 * Gets the total number of events in the list.
 * @return {number} Event count.
 */
wtf.db.EventList.prototype.getCount = function() {
  return this.count;
};


/**
 * Gets the time of the first event in the list.
 * @return {number} Time of the first event or 0 if no events.
 */
wtf.db.EventList.prototype.getFirstEventTime = function() {
  return this.firstEventTime_;
};


/**
 * Gets the time of the last event in the list.
 * @return {number} Time of the last event or 0 if no events.
 */
wtf.db.EventList.prototype.getLastEventTime = function() {
  return this.lastEventTime_;
};


/**
 * Gets the maximum depth of any scope in the list.
 * @return {number} Scope depth.
 */
wtf.db.EventList.prototype.getMaximumScopeDepth = function() {
  return this.maximumScopeDepth_;
};


/**
 * Inserts an event into the list.
 * @param {!wtf.db.EventType} eventType Event type.
 * @param {number} time Time, in microseconds.
 * @param {wtf.db.ArgumentData=} opt_argData Argument data.
 */
wtf.db.EventList.prototype.insert = function(eventType, time, opt_argData) {
  // Grow the event data store, if required.
  if (this.count + 1 >= this.capacity_) {
    // TODO(benvanik): better growth characteristics.
    this.capacity_ = Math.max(this.capacity_ * 2, 1024);
    var newSize = this.capacity_ * wtf.db.EventStruct.STRUCT_SIZE;
    var newData = new Uint32Array(newSize);
    var oldData = this.eventData;
    for (var n = 0; n < this.count * wtf.db.EventStruct.STRUCT_SIZE; n++) {
      newData[n] = oldData[n];
    }
    this.eventData = newData;
  }

  // Prep the event and return.
  var eventData = this.eventData;
  var o = this.count * wtf.db.EventStruct.STRUCT_SIZE;
  eventData[o + wtf.db.EventStruct.ID] = this.count;
  eventData[o + wtf.db.EventStruct.TYPE] = eventType.id;
  eventData[o + wtf.db.EventStruct.PARENT] = -1;
  eventData[o + wtf.db.EventStruct.TIME] = time;

  // If we were provided argument data, set here.
  if (opt_argData) {
    var args = opt_argData;
    args.id = this.nextArgumentDataId_++;
    this.argumentData_[args.id] = args;
    eventData[o + wtf.db.EventStruct.ARGUMENTS] = args.id;
  }

  this.count++;
};


/**
 * Rebuilds the internal event list data after a batch insertion.
 */
wtf.db.EventList.prototype.rebuild = function() {
  // Sort all events by time|id.
  this.resortEvents_();

  // Setup all scopes.
  // This builds parenting relationships and computes times.
  // It must occur after renumbering so that references are valid.
  this.rescopeEvents_();

  // Rebuild all ancillary lists.
  this.rebuildAncillaryLists_(this.ancillaryLists_);
};


/**
 * Resorts all event data in the backing buffer to be in time|id order.
 * @private
 */
wtf.db.EventList.prototype.resortEvents_ = function() {
  var eventData = this.eventData;

  // Build the sort index, used for sorting.
  // This allows us to run the sort and just shift around indices instead of
  // shifting around the real event data.
  var sortIndex = new Array(this.count);
  for (var n = 0; n < sortIndex.length; n++) {
    sortIndex[n] = n;
  }

  // Sort.
  sortIndex.sort(function(ai, bi) {
    var ao = ai * wtf.db.EventStruct.STRUCT_SIZE;
    var bo = bi * wtf.db.EventStruct.STRUCT_SIZE;
    var atime = eventData[ao + 4];
    var btime = eventData[bo + 4];
    if (atime == btime) {
      return eventData[ao] - eventData[bo];
    }
    return atime - btime;
  });

  // Rearrange the event data by the new sort index.
  // TODO(benvanik): do this in-place without the duplication.
  var newData = new Uint32Array(eventData.length);
  for (var n = 0; n < sortIndex.length; n++) {
    var oldOffset = sortIndex[n] * wtf.db.EventStruct.STRUCT_SIZE;
    var newOffset = n * wtf.db.EventStruct.STRUCT_SIZE;
    for (var si = oldOffset, di = newOffset;
        si < oldOffset + wtf.db.EventStruct.STRUCT_SIZE; si++, di++) {
      newData[di] = eventData[si];
    }
  }

  // Renumber all events to match their current order.
  for (var n = 0, o = 0; n < this.count; n++) {
    newData[o + wtf.db.EventStruct.ID] = n;
    o += wtf.db.EventStruct.STRUCT_SIZE;
  }

  this.eventData = newData;

  // Reset stats.
  this.firstEventTime_ = 0;
  this.lastEventTime_ = 0;
  if (this.count) {
    var it = new wtf.db.EventIterator(this, 0, this.count - 1, 0);
    this.firstEventTime_ = it.getTime();
    it.seek(this.count - 1);
    this.lastEventTime_ = it.isScope() ? it.getEndTime() : it.getTime();
  }
};


/**
 * Rebuilds the scoping data of events.
 * @private
 */
wtf.db.EventList.prototype.rescopeEvents_ = function() {
  // All events used are already declared.
  var scopeEnter = this.eventTypeTable.getByName('wtf.scope#enter');
  var scopeEnterId = scopeEnter ? scopeEnter.id : -1;
  var scopeLeave = this.eventTypeTable.getByName('wtf.scope#leave');
  var scopeLeaveId = scopeLeave ? scopeLeave.id : -1;
  var appendScopeData = this.eventTypeTable.getByName('wtf.scope#appendData');
  var appendScopeDataId = appendScopeData ? appendScopeData.id : -1;
  var timeStamp = this.eventTypeTable.getByName('wtf.trace#timeStamp');
  var timeStampId = timeStamp ? timeStamp.id : -1;

  // This stack is used to track the currently active scopes while scanning
  // forward.
  var stack = new Uint32Array(256);
  var typeStack = new Array(256);
  var childTimeStack = new Uint32Array(256);
  var systemTimeStack = new Uint32Array(256);
  var stackTop = 0;
  var stackMax = 0;

  // Directly poke into the event data array for speed.
  var eventData = this.eventData;
  for (var n = 0, o = 0; n < this.count; n++) {
    var parentId = stack[stackTop];
    eventData[o + wtf.db.EventStruct.PARENT] = parentId;
    eventData[o + wtf.db.EventStruct.DEPTH] = stackTop;

    // Set the next sibling to the next event.
    // If this is an scope enter then the leave will fix it up.
    var nextEventId = 0;
    if (n < this.count - 1) {
      nextEventId =
          eventData[o + wtf.db.EventStruct.STRUCT_SIZE + wtf.db.EventStruct.ID];
    }
    eventData[o + wtf.db.EventStruct.NEXT_SIBLING] = nextEventId;

    var typeId = eventData[o + wtf.db.EventStruct.TYPE];
    if (typeId == scopeEnterId) {
      // Generic scope enter.
      // We replace this with an on-demand event type.
      var args =
          this.argumentData_[eventData[o + wtf.db.EventStruct.ARGUMENTS]];
      var newEventType = this.eventTypeTable.getByName(args.get('name'));
      if (!newEventType) {
        newEventType = this.eventTypeTable.defineType(
            wtf.db.EventType.createScope(args.get('name')));
      }
      typeId = newEventType.id;
      eventData[o + wtf.db.EventStruct.TYPE] = newEventType.id;
      stack[++stackTop] = eventData[o + wtf.db.EventStruct.ID];
      typeStack[stackTop] = newEventType;
      stackMax = Math.max(stackMax, stackTop);
    } else if (typeId == scopeLeaveId) {
      // Scope leave.
      eventData[o + wtf.db.EventStruct.NEXT_SIBLING] = 0;
      stackTop--;

      var scopeOffset = parentId * wtf.db.EventStruct.STRUCT_SIZE;
      eventData[scopeOffset + wtf.db.EventStruct.NEXT_SIBLING] = nextEventId;
      var time = eventData[o + wtf.db.EventStruct.TIME];
      var duration = time - eventData[scopeOffset + wtf.db.EventStruct.TIME];
      eventData[scopeOffset + wtf.db.EventStruct.END_TIME] = time;

      // Accumulate timing data.
      // Computed on the stack so we don't have to rewalk events.
      // We roll the system time up into the parent level so that system times
      // are attributed all the way up.
      var childTime = childTimeStack[stackTop];
      var systemTime = systemTimeStack[stackTop];
      eventData[scopeOffset + wtf.db.EventStruct.SYSTEM_TIME] = systemTime;
      eventData[scopeOffset + wtf.db.EventStruct.CHILD_TIME] = childTime;
      childTimeStack[stackTop] = 0;
      systemTimeStack[stackTop] = 0;
      if (stackTop) {
        childTimeStack[stackTop - 1] += duration;
        if (typeStack[stackTop].flags & wtf.data.EventFlag.SYSTEM_TIME) {
          systemTime += duration;
        }
        systemTimeStack[stackTop - 1] += systemTime;
      }
    } else if (typeId == appendScopeDataId) {
      // appendScopeData.
      this.appendScopeData_(
          stack[stackTop], eventData[o + wtf.db.EventStruct.ARGUMENTS]);
    } else if (typeId == timeStampId) {
      // Generic timestamp.
      // Replace with an on-demand event type.
      var args =
          this.argumentData_[eventData[o + wtf.db.EventStruct.ARGUMENTS]];
      var newEventType = this.eventTypeTable.getByName(args.get('name'));
      if (!newEventType) {
        newEventType = this.eventTypeTable.defineType(
            wtf.db.EventType.createInstance(args.get('name')));
      }
      typeId = newEventType.id;
      eventData[o + wtf.db.EventStruct.TYPE] = newEventType.id;
    } else {
      // Remaining event types.
      var type = this.eventTypeTable.getById(typeId);
      if (type.eventClass == wtf.data.EventClass.SCOPE) {
        // Scope enter.
        stack[++stackTop] = eventData[o + wtf.db.EventStruct.ID];
        typeStack[stackTop] = type;
        stackMax = Math.max(stackMax, stackTop);
      }
    }
    o += wtf.db.EventStruct.STRUCT_SIZE;
  }

  this.maximumScopeDepth_ = stackMax;
};


/**
 * Handles an append scope data event by merging the arguments into the given
 * parent scope.
 * @param {number} scopeId Scope event ID.
 * @param {number} argsId Argument data ID to append.
 * @private
 */
wtf.db.EventList.prototype.appendScopeData_ = function(scopeId, argsId) {
  var eventData = this.eventData;
  var o = scopeId * wtf.db.EventStruct.STRUCT_SIZE;
  var scopeArgsId = eventData[o + wtf.db.EventStruct.ARGUMENTS];
  if (!scopeArgsId) {
    // Scope had no args, so just replace with the appendScopeData ones.
    eventData[o + wtf.db.EventStruct.ARGUMENTS] = argsId;
  } else {
    // Properly merge the arguments.
    this.argumentData_[scopeArgsId].merge(this.argumentData_[argsId]);
  }
};


/**
 * Rebuilds dependent ancillary lists.
 * @param {!Array.<!wtf.db.IAncillaryList>} lists Lists.
 * @private
 */
wtf.db.EventList.prototype.rebuildAncillaryLists_ = function(lists) {
  if (!lists.length) {
    return;
  }

  // Map of type ids -> list of ancillary lists and the types they registered.
  var typeMap = {};

  // Begin rebuild on all lists to gather types that we need.
  for (var n = 0; n < lists.length; n++) {
    var list = lists[n];
    var desiredTypes = list.beginRebuild(this.eventTypeTable);
    for (var m = 0; m < desiredTypes.length; m++) {
      var desiredType = desiredTypes[m];
      if (!desiredType) {
        continue;
      }
      var handlers = typeMap[desiredType.id];
      if (!handlers) {
        typeMap[desiredType.id] = handlers = [];
      }
      handlers.push({
        list: list,
        eventTypeIndex: m,
        eventType: desiredType
      });
    }
  }

  // Run through all events and dispatch to their handlers.
  var eventData = this.eventData;
  var it = new wtf.db.EventIterator(this, 0, this.count - 1, 0);
  for (var n = 0, o = 0; n < this.count; n++) {
    var typeId = eventData[o + wtf.db.EventStruct.TYPE];
    var handlers = typeMap[typeId];
    if (handlers) {
      for (var m = 0; m < handlers.length; m++) {
        // Reset the iterator each handler in case the handler messes with it.
        it.seek(n);
        var handler = handlers[m];
        handler.list.handleEvent(handler.eventTypeIndex, handler.eventType, it);
      }
    }
    o += wtf.db.EventStruct.STRUCT_SIZE;
  }

  // Call end rebuild so the lists can clean up.
  for (var n = 0; n < lists.length; n++) {
    var list = lists[n];
    list.endRebuild();
  }
};


/**
 * Gets the argument data with the given ID.
 * @param {number} argsId Key into the argument data table.
 * @return {wtf.db.ArgumentData} Argument data, if any.
 */
wtf.db.EventList.prototype.getArgumentData = function(argsId) {
  return this.argumentData_[argsId] || null;
};


/**
 * Dumps the event list to the console for debugging.
 */
wtf.db.EventList.prototype.dump = function() {
  var it = new wtf.db.EventIterator(this, 0, this.count - 1, 0);
  while (!it.done()) {
    var s = '';
    var d = it.getDepth();
    while (d--) {
      s += '  ';
    }
    s += wtf.util.formatTime(it.getTime() / 1000);
    s += ' ';
    s += it.getType().getName();
    goog.global.console.log(s);

    it.next();
  }
};


/**
 * Begins iterating the entire event list.
 * @return {!wtf.db.EventIterator} Iterator.
 */
wtf.db.EventList.prototype.begin = function() {
  return new wtf.db.EventIterator(
      this, 0, this.getCount(), 0);
};


/**
 * Begins iterating the given time-based subset of the event list.
 * @param {number} startTime Start time.
 * @param {number} endTime End time.
 * @param {boolean=} opt_startAtRoot Whether to start at the enclosing root
 *     scope.
 * @return {!wtf.db.EventIterator} Iterator.
 */
wtf.db.EventList.prototype.beginTimeRange = function(
    startTime, endTime, opt_startAtRoot) {
  var startIndex = opt_startAtRoot ?
      this.getIndexOfRootScopeIncludingTime(startTime) :
      this.getIndexOfEventNearTime(startTime);
  var endIndex = this.getIndexOfEventNearTime(endTime);
  if (endIndex < startIndex) {
    endIndex = startIndex;
  }
  return this.beginEventRange(startIndex, endIndex);
};


/**
 * Begins iterating the given event index-based subset of the event list.
 * @param {number} startIndex Start index.
 * @param {number} endIndex End index.
 * @return {!wtf.db.EventIterator} Iterator.
 */
wtf.db.EventList.prototype.beginEventRange = function(startIndex, endIndex) {
  return new wtf.db.EventIterator(
      this, startIndex, endIndex, startIndex);
};


/**
 * Gets the index of the event near the given time.
 * If there is no event at the given time the one before it is returned.
 * @param {number} time Time.
 * @return {number} Event index.
 */
wtf.db.EventList.prototype.getIndexOfEventNearTime = function(time) {
  time *= 1000;
  var eventData = this.eventData;
  var low = 0;
  var high = this.count - 1;
  while (low < high) {
    var mid = ((low + high) / 2) | 0;
    var o = mid * wtf.db.EventStruct.STRUCT_SIZE;
    var midValue = eventData[o + wtf.db.EventStruct.TIME];
    if (midValue < time) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low ? low - 1 : 0;
};


/**
 * Gets an iterator on the event near the given time.
 * @param {number} time Time.
 * @return {!wtf.db.EventIterator} Iterator.
 */
wtf.db.EventList.prototype.getEventNearTime = function(time) {
  var id = this.getIndexOfEventNearTime(time);
  return this.getEvent(id);
};


/**
 * Gets the index of the first root scope including the given time.
 * This is useful when drawing to ensure that scopes intersecting the viewport
 * are visible. If no root scope is found that includes the given time then the
 * behavior will be like {@see #getIndexOfEventNearTime}.
 * @param {number} time Time to ensure is included.
 * @return {number} Event ID or 0 if not found.
 */
wtf.db.EventList.prototype.getIndexOfRootScopeIncludingTime = function(time) {
  var nearId = this.getIndexOfEventNearTime(time);
  if (!nearId) {
    return 0;
  }
  time *= 1000;

  var eventData = this.eventData;
  var i = nearId;
  while (i >= 0) {
    // Move to the root scope.
    var o = i * wtf.db.EventStruct.STRUCT_SIZE;
    var depth = eventData[o + wtf.db.EventStruct.DEPTH];
    while (depth-- > 0) {
      o = i * wtf.db.EventStruct.STRUCT_SIZE;
      i = eventData[o + wtf.db.EventStruct.PARENT];
    }
    o = i * wtf.db.EventStruct.STRUCT_SIZE;

    // If it's a scope, probably found!
    if (!!eventData[o + wtf.db.EventStruct.END_TIME]) {
      // Found a root scope.
      var endTime = eventData[o + wtf.db.EventStruct.END_TIME];
      if (endTime < time) {
        // Root scope ends before the requested time - just return near ID.
        return nearId;
      } else {
        // Root scope includes the time.
        return i;
      }
    }

    i--;
  }

  return nearId;
};


/**
 * Gets an iterator for the given event.
 * @param {number} id Event ID.
 * @return {!wtf.db.EventIterator} Iterator.
 */
wtf.db.EventList.prototype.getEvent = function(id) {
  return new wtf.db.EventIterator(this, id, id, id);
};



/**
 * Event iterator.
 * Used for iterating over and accessing event data.
 *
 * @param {!wtf.db.EventList} eventList Data scope.
 * @param {number} firstIndex Start of the iterator.
 * @param {number} lastIndex End of the iterator.
 * @param {number} index Current position of the iterator.
 * @param {Array.<number>=} opt_indirectionTable Indirection table.
 * @constructor
 */
wtf.db.EventIterator = function(eventList, firstIndex, lastIndex, index,
    opt_indirectionTable) {
  /**
   * Data scope.
   * @type {!wtf.db.EventList}
   * @private
   */
  this.eventList_ = eventList;

  /**
   * First allowed index in the event data store.
   * @type {number}
   * @private
   */
  this.firstIndex_ = firstIndex;

  /**
   * Last allowed index in the event data store.
   * @type {number}
   * @private
   */
  this.lastIndex_ = lastIndex;

  /**
   * Current index into the event data store.
   * @type {number}
   * @private
   */
  this.index_ = index;

  /**
   * Indirection table used to translate the current index of the iterator
   * into event offsets in the data store.
   * If this is not defined then a simple [0-n] mapping is used.
   * @type {Array.<number>}
   * @private
   */
  this.indirectionTable_ = opt_indirectionTable || null;

  /**
   * Event data structure.
   * @type {!Uint32Array}
   * @private
   */
  this.eventData_ = eventList.eventData;

  /**
   * Offset into the data array.
   * This is stored as /4.
   * @type {number}
   * @private
   */
  this.offset_ = -1;

  /**
   * A cached iterator used for fast mode {@see #getParent}.
   * Initialized on demand.
   * @type {wtf.db.EventIterator}
   * @private
   */
  this.cachedParentIt_ = null;

  this.seek(this.index_);
};


/**
 * Moves to a specific event, relative to the iterator range.
 * @param {number} index Index.
 */
wtf.db.EventIterator.prototype.seek = function(index) {
  if (index < 0) {
    this.index_ = this.lastIndex_ + 1;
    return;
  }
  this.index_ = index;
  if (this.index_ > this.lastIndex_) {
    return;
  }
  var i = this.indirectionTable_ ?
      this.indirectionTable_[this.index_] : this.index_;
  this.offset_ = i * wtf.db.EventStruct.STRUCT_SIZE;
};


/**
 * Moves to the next event.
 */
wtf.db.EventIterator.prototype.next = function() {
  ++this.index_;
  var i = this.indirectionTable_ ?
      this.indirectionTable_[this.index_] : this.index_;
  this.offset_ = i * wtf.db.EventStruct.STRUCT_SIZE;
};


/**
 * Moves to the next scope event.
 */
wtf.db.EventIterator.prototype.nextScope = function() {
  // This is inlined because painters use it.
  var eventData = this.eventData_;
  var i = this.index_;
  var o = this.offset_;
  while (i <= this.lastIndex_) {
    i++;
    o += wtf.db.EventStruct.STRUCT_SIZE;
    if (eventData[o + wtf.db.EventStruct.END_TIME]) {
      break;
    }
  }
  this.index_ = i;
  this.offset_ = o;
};


/**
 * Moves to the next instance event.
 */
wtf.db.EventIterator.prototype.nextInstance = function() {
  // This is inlined because painters use it.
  var eventData = this.eventData_;
  var i = this.index_;
  var o = this.offset_;
  while (i <= this.lastIndex_) {
    i++;
    o += wtf.db.EventStruct.STRUCT_SIZE;
    if (!eventData[o + wtf.db.EventStruct.END_TIME]) {
      break;
    }
  }
  this.index_ = i;
  this.offset_ = o;
};


/**
 * Moves the iterator to the next sibling event, skipping all descendants.
 */
wtf.db.EventIterator.prototype.nextSibling = function() {
  this.seek(this.eventData_[this.offset_ + wtf.db.EventStruct.NEXT_SIBLING]);
};


/**
 * Moves to the parent of the current event.
 */
wtf.db.EventIterator.prototype.moveToParent = function() {
  var parentIndex = this.eventData_[this.offset_ + wtf.db.EventStruct.PARENT];
  if (parentIndex >= 0) {
    this.seek(parentIndex);
  } else {
    // No parent, move to end.
    this.seek(this.lastIndex_ + 1);
  }
};


/**
 * Whether the iterator is at the end.
 * @return {boolean} True if the iterator is at the end/empty.
 */
wtf.db.EventIterator.prototype.done = function() {
  return this.index_ > this.lastIndex_;
};


/**
 * Gets the unique ID of the current event.
 * @return {number} Event ID.
 */
wtf.db.EventIterator.prototype.getId = function() {
  return this.eventData_[this.offset_ + wtf.db.EventStruct.ID];
};


/**
 * Gets the type of the current event.
 * @return {!wtf.db.EventType} Event type.
 */
wtf.db.EventIterator.prototype.getType = function() {
  // TODO(benvanik): cache until move
  var typeId = this.eventData_[this.offset_ + wtf.db.EventStruct.TYPE];
  return /** @type {!wtf.db.EventType} */ (
      this.eventList_.eventTypeTable.getById(typeId));
};


/**
 * Gets the name the current event.
 * @return {string} Event name.
 */
wtf.db.EventIterator.prototype.getName = function() {
  var type = this.getType();
  return type.getName();
};


/**
 * Gets the event type flags.
 * @return {number} A bitmask of {@see wtf.data.EventFlag}.
 */
wtf.db.EventIterator.prototype.getTypeFlags = function() {
  // TODO(benvanik): inline this into the structure? It's called during a lot of
  //     entire-db scans.
  var type = this.getType();
  return type.flags;
};


/**
 * Whether the current event is a scope type.
 * @return {boolean} True if the event is a scope event type.
 */
wtf.db.EventIterator.prototype.isScope = function() {
  return !!this.eventData_[this.offset_ + wtf.db.EventStruct.END_TIME];
};


/**
 * Whether the current event is an instance type.
 * @return {boolean} True if the event is an instance event type.
 */
wtf.db.EventIterator.prototype.isInstance = function() {
  return !this.eventData_[this.offset_ + wtf.db.EventStruct.END_TIME];
};


/**
 * Gets the parent of the current event, unless it is the root.
 * @param {boolean=} opt_fast True to use a cached iterator. This prevents an
 *     allocation and greatly speeds up the operation if the iterator will not
 *     be retained by the caller.
 * @return {wtf.db.EventIterator} Parent scope, if any.
 */
wtf.db.EventIterator.prototype.getParent = function(opt_fast) {
  var parentIndex = this.eventData_[this.offset_ + wtf.db.EventStruct.PARENT];
  if (parentIndex >= 0) {
    if (opt_fast) {
      var it = this.cachedParentIt_;
      if (!it) {
        it = this.cachedParentIt_ = new wtf.db.EventIterator(
            this.eventList_, 0, this.eventList_.count, parentIndex);
      } else {
        it.seek(parentIndex);
      }
      return it;
    } else {
      return new wtf.db.EventIterator(
          this.eventList_,
          0, this.eventList_.count,
          parentIndex);
    }
  }
  return null;
};


/**
 * Gets the depth (distance from root) of the current event.
 * @return {number} Scope depth.
 */
wtf.db.EventIterator.prototype.getDepth = function() {
  return this.eventData_[this.offset_ + wtf.db.EventStruct.DEPTH];
};


/**
 * Gets the time of the current event.
 * If this is a scope event the time indicates the time of entry.
 * @return {number} Event time.
 */
wtf.db.EventIterator.prototype.getTime = function() {
  return this.eventData_[this.offset_ + wtf.db.EventStruct.TIME] / 1000;
};


/**
 * Gets the argument data for the current event, if any.
 * @return {wtf.db.ArgumentData} Argument data, if any.
 */
wtf.db.EventIterator.prototype.getArguments = function() {
  var argsId = this.eventData_[this.offset_ + wtf.db.EventStruct.ARGUMENTS];
  return argsId ? this.eventList_.getArgumentData(argsId) : null;
};


/**
 * Gets the argument value from the current event with the given key.
 * @param {string} key Argument key.
 * @return {*} Argument value or undefined if not found.
 */
wtf.db.EventIterator.prototype.getArgument = function(key) {
  // TODO(benvanik): cache until move
  var args = this.getArguments();
  return args ? args.get(key) : undefined;
};


// wtf.db.EventIterator.prototype.getFlow = function() {
//   var valueId = this.eventData_[this.offset_ + wtf.db.EventStruct.VALUE];
//   return null;
// };


/**
 * Gets the application-defined event tagfor the current event, if any.
 * @return {number} Event tag.
 */
wtf.db.EventIterator.prototype.getTag = function() {
  return this.eventData_[this.offset_ + wtf.db.EventStruct.TAG];
};


/**
 * Sets the application-defined event tag for the current event, if any.
 * @param {number} value Event tag.
 */
wtf.db.EventIterator.prototype.setTag = function(value) {
  this.eventData_[this.offset_ + wtf.db.EventStruct.TAG] = value;
};


/**
 * Gets the time the current scope ended.
 * Only valid for scope events.
 * @return {number} Scope end time.
 */
wtf.db.EventIterator.prototype.getEndTime = function() {
  return this.eventData_[this.offset_ + wtf.db.EventStruct.END_TIME] / 1000;
};


/**
 * Gets the duration of the current scope.
 * This may exclude tracing time.
 * Only valid for scope events.
 * @return {number} Total duration of the scope including system time.
 */
wtf.db.EventIterator.prototype.getTotalDuration = function() {
  var eventData = this.eventData_;
  var o = this.offset_;
  return (eventData[o + wtf.db.EventStruct.END_TIME] -
      eventData[o + wtf.db.EventStruct.TIME]) / 1000;
};


/**
 * Gets the duration of the current scope minus system time.
 * Only valid for scope events.
 * @return {number} Total duration of the scope excluding system time.
 */
wtf.db.EventIterator.prototype.getUserDuration = function() {
  var eventData = this.eventData_;
  var o = this.offset_;
  var total =
      eventData[o + wtf.db.EventStruct.END_TIME] -
      eventData[o + wtf.db.EventStruct.TIME];
  return (total - eventData[o + wtf.db.EventStruct.SYSTEM_TIME]) / 1000;
};


/**
 * Gets the duration of the current scope minus its children and system time.
 * Only valid for scope events.
 * @return {number} Total duration of the scope excluding children.
 */
wtf.db.EventIterator.prototype.getOwnDuration = function() {
  var eventData = this.eventData_;
  var o = this.offset_;
  var total =
      eventData[o + wtf.db.EventStruct.END_TIME] -
      eventData[o + wtf.db.EventStruct.TIME];
  return (total - eventData[o + wtf.db.EventStruct.CHILD_TIME]) / 1000;
};


/**
 * Gets an informative string about the current event.
 * @return {string?} Info string.
 */
wtf.db.EventIterator.prototype.getInfoString = function() {
  if (this.done()) {
    return null;
  }
  if (this.isScope()) {
    return this.getScopeInfoString_();
  } else if (this.isInstance()) {
    return this.getInstanceInfoString_();
  }
  return null;
};


/**
 * Gets an informative string about the current scope event.
 * @return {string} Info string.
 * @private
 */
wtf.db.EventIterator.prototype.getScopeInfoString_ = function() {
  var totalTime = wtf.util.formatTime(this.getTotalDuration());
  var times = totalTime;
  if (this.getTotalDuration() - this.getOwnDuration()) {
    var ownTime = wtf.util.formatTime(this.getOwnDuration());
    times += ' (' + ownTime + ')';
  }

  var type = this.getType();
  var lines = [
    times + ': ' + type.name
  ];

  var args = this.getArguments();
  if (args) {
    wtf.util.addArgumentLines(lines, args.toObject());
  }

  return lines.join('\n');
};


/**
 * Gets an informative string about the current instance event.
 * @return {string} Info string.
 * @private
 */
wtf.db.EventIterator.prototype.getInstanceInfoString_ = function() {
  var lines = [];

  var type = this.getType();
  lines.push(type.name);

  var args = this.getArguments();
  if (args) {
    wtf.util.addArgumentLines(lines, args.toObject());
  }

  return lines.join('\n');
};
