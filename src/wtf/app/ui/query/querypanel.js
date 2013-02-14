/**
 * Copyright 2012 Google, Inc. All Rights Reserved.
 *
 * Use of this source code is governed by a BSD-style license that can be
 * found in the LICENSE file.
 */

/**
 * @fileoverview 'Query' panel.
 *
 * @author benvanik@google.com (Ben Vanik)
 */

goog.provide('wtf.app.ui.query.QueryPanel');

goog.require('goog.dom.classes');
goog.require('goog.events.EventType');
goog.require('goog.soy');
goog.require('goog.style');
goog.require('wtf.app.ui.TabPanel');
goog.require('wtf.app.ui.query.QueryTableSource');
goog.require('wtf.app.ui.query.querypanel');
goog.require('wtf.db.QueryDumpFormat');
goog.require('wtf.events');
goog.require('wtf.events.EventType');
goog.require('wtf.events.KeyboardScope');
goog.require('wtf.pal');
goog.require('wtf.ui.SearchControl');
goog.require('wtf.ui.VirtualTable');
goog.require('wtf.util');



/**
 * Query panel, allowing for database query.
 * @param {!wtf.app.ui.DocumentView} documentView Parent document view.
 * @constructor
 * @extends {wtf.app.ui.TabPanel}
 */
wtf.app.ui.query.QueryPanel = function(documentView) {
  goog.base(this, documentView, 'query', 'Query');
  var dom = this.getDom();

  var doc = documentView.getDocument();
  var db = doc.getDatabase();

  /**
   * Database.
   * @type {!wtf.db.EventDatabase}
   * @private
   */
  this.db_ = db;

  /**
   * Search text field.
   * @type {!wtf.ui.SearchControl}
   * @private
   */
  this.searchControl_ = new wtf.ui.SearchControl(
      this.getChildElement(goog.getCssName('headerLeft')), dom);
  this.registerDisposable(this.searchControl_);
  this.searchControl_.setPlaceholderText(
      'substring or /regex/ or XPath-like query');

  /**
   * Results table.
   * @type {!wtf.ui.VirtualTable}
   * @private
   */
  this.table_ = new wtf.ui.VirtualTable(
      this.getChildElement(goog.getCssName('results')), dom);
  this.registerDisposable(this.table_);

  /**
   * Current query results, if any.
   * @type {wtf.db.QueryResult}
   * @private
   */
  this.currentResults_ = null;

  /**
   * Query info element.
   * @type {!Element}
   * @private
   */
  this.infoEl_ = this.getChildElement(goog.getCssName('resultInfo'));

  /**
   * Root empty display container.
   * This is shown when there is an error or the search box is empty.
   * @type {!Element}
   * @private
   */
  this.emptyEl_ = this.getChildElement(goog.getCssName('empty'));

  /**
   * Error display element.
   * @type {!Element}
   * @private
   */
  this.errorEl_ = this.getChildElement(goog.getCssName('error'));

  /**
   * A list of the button <a>'s for easy toggling.
   * @type {!Array.<!Element>}
   * @private
   */
  this.buttonEls_ = [
    this.getChildElement(goog.getCssName('saveCsvResults'))
  ];

  var commandManager = wtf.events.getCommandManager();
  commandManager.registerSimpleCommand(
      'query', function(source, target, expression) {
        this.issueQuery_(expression);
      }, this);

  this.searchControl_.addListener(
      wtf.events.EventType.INVALIDATED,
      function(newValue, oldValue) {
        commandManager.execute('query', this, null, newValue);
      }, this);

  // Setup keyboard hooks. These are only valid when the panel is active.
  var keyboard = wtf.events.getWindowKeyboard(dom);
  /**
   * Keyboard scope.
   * @type {!wtf.events.KeyboardScope}
   * @private
   */
  this.keyboardScope_ = new wtf.events.KeyboardScope(keyboard);
  this.registerDisposable(this.keyboardScope_);
  this.setupKeyboardShortcuts_();

  // Button handling.
  this.getHandler().listen(
      this.getChildElement(goog.getCssName('saveCsvResults')),
      goog.events.EventType.CLICK,
      function(e) {
        e.preventDefault();
        if (!this.currentResults_) {
          return;
        }

        var dump = this.currentResults_.dump(
            wtf.db.QueryDumpFormat.CSV);
        if (dump) {
          var pal = wtf.pal.getPlatform();
          pal.writeTextFile('wtf-query.csv', dump, 'text/csv');
        }
      }, false);

  this.clear();
};
goog.inherits(wtf.app.ui.query.QueryPanel, wtf.app.ui.TabPanel);


/**
 * @override
 */
wtf.app.ui.query.QueryPanel.prototype.disposeInternal = function() {
  var commandManager = wtf.events.getCommandManager();
  commandManager.unregisterCommand('query');
  goog.base(this, 'disposeInternal');
};


/**
 * @override
 */
wtf.app.ui.query.QueryPanel.prototype.createDom = function(dom) {
  return /** @type {!Element} */ (goog.soy.renderAsFragment(
      wtf.app.ui.query.querypanel.control, undefined, undefined, dom));
};


/**
 * @override
 */
wtf.app.ui.query.QueryPanel.prototype.layoutInternal = function() {
  this.table_.layout();
};


/**
 * Sets up some simple keyboard shortcuts.
 * @private
 */
wtf.app.ui.query.QueryPanel.prototype.setupKeyboardShortcuts_ = function() {
  var commandManager = wtf.events.getCommandManager();
  var keyboardScope = this.keyboardScope_;

  keyboardScope.addShortcut('command+f', function() {
    this.searchControl_.focus();
  }, this);
  keyboardScope.addShortcut('esc', function() {
    commandManager.execute('query', this, null, '');
  }, this);
};


/**
 * @override
 */
wtf.app.ui.query.QueryPanel.prototype.setVisible = function(value) {
  goog.base(this, 'setVisible', value);
  this.keyboardScope_.setEnabled(value);
};


/**
 * @override
 */
wtf.app.ui.query.QueryPanel.prototype.navigate = function(pathParts) {
  // TODO(benvanik): support navigation
};


/**
 * Clears the results.
 */
wtf.app.ui.query.QueryPanel.prototype.clear = function() {
  var dom = this.getDom();

  // Clear results.
  this.currentResults_ = null;
  this.table_.setSource(null);
  dom.setTextContent(this.infoEl_, '');
  dom.setTextContent(this.errorEl_, '');

  // Clear errors/show empty help text.
  this.searchControl_.toggleError(false);
  goog.style.showElement(this.emptyEl_, true);
  goog.style.showElement(this.errorEl_, false);

  // Disable all buttons.
  for (var n = 0; n < this.buttonEls_.length; n++) {
    var buttonEl = this.buttonEls_[n];
    goog.dom.classes.add(buttonEl, goog.getCssName('kDisabled'));
  }
};


/**
 * Issues a query.
 * @param {string} expression Query string.
 * @private
 */
wtf.app.ui.query.QueryPanel.prototype.issueQuery_ = function(expression) {
  var dom = this.getDom();

  // Clear results.
  this.clear();

  // Attempt to set the search control.
  this.searchControl_.setValue(expression);
  if (!expression.length) {
    return;
  }

  // Create the query.
  // It throws if there's an error parsing it.
  var query;
  var error = null;
  try {
    query = this.db_.query(expression);
  } catch (e) {
    error = e.toString();
  }

  // Toggle error state.
  this.searchControl_.toggleError(!!error);
  goog.style.showElement(this.emptyEl_, !!error);
  goog.style.showElement(this.errorEl_, !!error);
  if (error) {
    dom.setTextContent(this.infoEl_, '');
    dom.setTextContent(this.errorEl_, error);
    return;
  }
  this.infoEl_.title = query.getCompiledExpression().toString();

  // Enable buttons.
  this.currentResults_ = query;
  for (var n = 0; n < this.buttonEls_.length; n++) {
    var buttonEl = this.buttonEls_[n];
    goog.dom.classes.remove(buttonEl, goog.getCssName('kDisabled'));
  }

  var result = query.getRows();

  // Update info with query stats.
  dom.setTextContent(this.infoEl_, result.length + ' hits in ' +
      wtf.util.formatSmallTime(query.getDuration()));

  // Update the table.
  this.table_.setSource(new wtf.app.ui.query.QueryTableSource(result));
};
