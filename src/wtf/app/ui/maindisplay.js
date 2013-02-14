/**
 * Copyright 2012 Google, Inc. All Rights Reserved.
 *
 * Use of this source code is governed by a BSD-style license that can be
 * found in the LICENSE file.
 */

/**
 * @fileoverview Main WTF UI.
 *
 * @author benvanik@google.com (Ben Vanik)
 */

goog.provide('wtf.app.ui.MainDisplay');

goog.require('goog.Uri');
goog.require('goog.array');
goog.require('goog.asserts');
goog.require('goog.async.Deferred');
goog.require('goog.async.DeferredList');
goog.require('goog.dom');
goog.require('goog.dom.TagName');
goog.require('goog.events');
goog.require('goog.events.EventType');
goog.require('goog.fs.FileReader');
goog.require('goog.net.EventType');
goog.require('goog.net.XhrIo');
goog.require('goog.result');
goog.require('goog.soy');
goog.require('goog.string');
goog.require('wtf.app.ui.DocumentView');
goog.require('wtf.app.ui.HelpDialog');
goog.require('wtf.app.ui.SplashDialog');
goog.require('wtf.app.ui.maindisplay');
goog.require('wtf.doc.Document');
goog.require('wtf.events');
goog.require('wtf.events.CommandManager');
goog.require('wtf.events.KeyboardScope');
goog.require('wtf.ext');
goog.require('wtf.io');
goog.require('wtf.io.drive');
goog.require('wtf.ipc');
goog.require('wtf.ipc.Channel');
goog.require('wtf.pal');
goog.require('wtf.timing');
goog.require('wtf.ui.Control');
goog.require('wtf.ui.Dialog');
goog.require('wtf.ui.ErrorDialog');
goog.require('wtf.ui.SettingsDialog');



/**
 * Main WTF UI.
 * Manages the main UI (menus/etc), active traces (and their trace views), etc.
 *
 * @param {!wtf.pal.IPlatform} platform Platform abstraction layer.
 * @param {!wtf.util.Options} options Options.
 * @param {Element=} opt_parentElement Element to display in.
 * @param {goog.dom.DomHelper=} opt_dom DOM helper.
 * @constructor
 * @extends {wtf.ui.Control}
 */
wtf.app.ui.MainDisplay = function(
    platform, options, opt_parentElement, opt_dom) {
  var dom = opt_dom || goog.dom.getDomHelper(opt_parentElement);
  var parentElement = /** @type {!Element} */ (
      opt_parentElement || dom.getDocument().body);
  goog.base(this, parentElement, dom);

  /**
   * Options overrides.
   * @type {!wtf.util.Options}
   * @private
   */
  this.options_ = options;

  /**
   * Platform abstraction layer.
   * @type {!wtf.pal.IPlatform}
   * @private
   */
  this.platform_ = platform;

  /**
   * Command manager.
   * @type {!wtf.events.CommandManager}
   * @private
   */
  this.commandManager_ = new wtf.events.CommandManager();
  wtf.events.CommandManager.setShared(this.commandManager_);

  /**
   * Any active dialog.
   * @type {wtf.ui.Dialog}
   * @private
   */
  this.activeDialog_ = null;

  /**
   * The current document view, if any.
   * @type {wtf.app.ui.DocumentView}
   * @private
   */
  this.documentView_ = null;

  /**
   * Parent window channel, if one exists.
   * @type {wtf.ipc.Channel}
   * @private
   */
  this.channel_ = null;
  wtf.ipc.connectToParentWindow(function(channel) {
    if (channel) {
      this.channel_ = channel;
      this.channel_.addListener(
          wtf.ipc.Channel.EventType.MESSAGE,
          this.channelMessage_, this);
    }
  }, this);

  // Setup command manager.
  this.commandManager_.registerSimpleCommand(
      'open_trace', this.requestTraceLoad, this);
  this.commandManager_.registerSimpleCommand(
      'open_drive_trace', this.requestDriveTraceLoad, this);
  this.commandManager_.registerSimpleCommand(
      'save_trace', this.saveTrace_, this);
  this.commandManager_.registerSimpleCommand(
      'share_trace', this.shareTrace_, this);
  this.commandManager_.registerSimpleCommand(
      'show_settings', this.showSettings_, this);
  this.commandManager_.registerSimpleCommand(
      'toggle_help', this.toggleHelpDialog_, this);

  // Setup keyboard shortcuts.
  var keyboard = wtf.events.getWindowKeyboard(dom);
  var keyboardScope = new wtf.events.KeyboardScope(keyboard);
  this.registerDisposable(keyboardScope);
  keyboardScope.addCommandShortcut('command+o', 'open_trace');
  keyboardScope.addCommandShortcut('command+s', 'save_trace');
  keyboardScope.addCommandShortcut('shift+/', 'toggle_help');

  if (wtf.io.drive.isSupported()) {
    wtf.io.drive.prepare();
  }
  this.setupDragDropLoading_();

  // Look for launch arguments.
  var startupLoad = false;
  var launchUri = goog.Uri.parse(dom.getWindow().location.toString());
  var queryData = launchUri.getQueryData();
  if (queryData.containsKey('url')) {
    // ?url=a.wtf.trace,b.wtf-trace
    // A list of URLs to open via XHR.
    var urls = queryData.get('url');
    if (urls && urls.length) {
      _gaq.push(['_trackEvent', 'app', 'open_querystring_files']);
      this.loadNetworkTraces(urls.split(','));
      startupLoad = true;
    }
  } else if (queryData.containsKey('expect_data')) {
    // ?expect_data
    // Indicates that a snapshot is incoming and the UI should be ready for it.
    // Strip this off and reset the URL so that if the user reloads/etc it
    // doesn't mess things up.
    queryData.remove('expect_data');
    startupLoad = true;
  }

  // Replace URL with a sanitized version.
  if (goog.global.history && goog.global.history.replaceState) {
    goog.global.history.replaceState(null, dom.getDocument().title || '',
        launchUri.toString());
  }

  // Show the splash screen only if we aren't expecting data.
  if (!startupLoad) {
    this.showSplashDialog_(true);
  }
};
goog.inherits(wtf.app.ui.MainDisplay, wtf.ui.Control);


/**
 * @override
 */
wtf.app.ui.MainDisplay.prototype.disposeInternal = function() {
  goog.dispose(this.activeDialog_);
  this.activeDialog_ = null;

  goog.dom.removeNode(this.getRootElement());
  this.setDocumentView(null);

  wtf.events.CommandManager.setShared(null);

  goog.base(this, 'disposeInternal');
};


/**
 * @override
 */
wtf.app.ui.MainDisplay.prototype.createDom = function(dom) {
  return /** @type {!Element} */ (goog.soy.renderAsFragment(
      wtf.app.ui.maindisplay.control, {
      }, undefined, dom));
};


/**
 * Sets up drag-drop file loading for wtf-trace files.
 * @private
 */
wtf.app.ui.MainDisplay.prototype.setupDragDropLoading_ = function() {
  var doc = this.getDom().getDocument();
  var eh = this.getHandler();
  eh.listen(doc.body, goog.events.EventType.DRAGENTER, function(e) {
    e.preventDefault();
  }, false, this);
  eh.listen(doc.body, goog.events.EventType.DRAGOVER, function(e) {
    e.preventDefault();
  }, false, this);
  eh.listen(doc.body, goog.events.EventType.DROP, function(e) {
    var browserEvent = e.getBrowserEvent();
    if (browserEvent.dataTransfer && browserEvent.dataTransfer.files &&
        browserEvent.dataTransfer.files.length) {
      e.stopPropagation();
      e.preventDefault();

      _gaq.push(['_trackEvent', 'app', 'open_drag_files']);

      this.loadTraceFiles(browserEvent.dataTransfer.files);
    }
  }, false, this);
};


/**
 * Sets the title of the tab.
 * This portion is used as the suffix after the application name.
 * @param {string?} value New value, or null to clear.
 * @private
 */
wtf.app.ui.MainDisplay.prototype.setTitle_ = function(value) {
  var title = 'Web Tracing Framework';
  if (!COMPILED) {
    title += ' (DEBUG)';
  }
  if (value && value.length) {
    title += ': ' + value;
  }
  var doc = this.getDom().getDocument();
  doc.title = title;
};


/**
 * Sets the title of the tab from the given filenames.
 * @param {!Array.<string>} filenames A list of filenames (paths/URLs allowed).
 * @private
 */
wtf.app.ui.MainDisplay.prototype.setTitleFromFilenames_ = function(filenames) {
  var title = '';
  for (var n = 0; n < filenames.length; n++) {
    var filename = filenames[n];
    var lastSlash = filename.lastIndexOf('/');
    if (lastSlash != -1) {
      filename = filename.substr(lastSlash + 1);
    }
    title += filename;
  }
  this.setTitle_(title);
};


/**
 * Gets the active document view.
 * @return {wtf.app.ui.DocumentView} Document view, if any.
 */
wtf.app.ui.MainDisplay.prototype.getDocumentView = function() {
  return this.documentView_;
};


/**
 * Sets the active document view, disposing any previous one.
 * @param {wtf.app.ui.DocumentView} documentView New document view.
 */
wtf.app.ui.MainDisplay.prototype.setDocumentView = function(documentView) {
  if (this.documentView_ == documentView) {
    return;
  }

  goog.dispose(this.documentView_);
  this.documentView_ = null;

  // Show the splash dialog if needed.
  this.showSplashDialog_(!documentView);

  if (documentView) {
    // TODO(benvanik): notify of change?
    this.documentView_ = documentView;
  } else {
    this.setTitle_(null);
  }
};


/**
 * Sets up a new document view for the given document and switches to it.
 * @param {!wtf.doc.Document} doc Document.
 */
wtf.app.ui.MainDisplay.prototype.openDocument = function(doc) {
  _gaq.push(['_trackEvent', 'app', 'open_document']);

  this.setDocumentView(null);
  var documentView = new wtf.app.ui.DocumentView(
      this.getChildElement(goog.getCssName('appUiMainDocumentView')),
      this.getDom(),
      doc);
  this.setDocumentView(documentView);
};


/**
 * Handles channel messages from the parent window.
 * @param {!Object} data Incoming data.
 * @private
 */
wtf.app.ui.MainDisplay.prototype.channelMessage_ = function(data) {
  switch (data['command']) {
    case 'snapshot':
      this.handleSnapshotCommand_(data);
      break;
    case 'stream_created':
      this.handleStreamCreatedCommand_(data);
      break;
    case 'stream_appended':
      this.handleStreamAppendedCommand_(data);
      break;
  }
};


/**
 * Handles snapshot IPC commands.
 * @param {!Object} data Command data.
 * @private
 */
wtf.app.ui.MainDisplay.prototype.handleSnapshotCommand_ = function(data) {
  var contentType = data['content_type'];
  var datas = data['contents'];

  if (!datas.length) {
    return;
  }

  // Convert data from Arrays to ensure we are typed all the way through.
  var contentLength = 0;
  for (var n = 0; n < datas.length; n++) {
    if (goog.isArray(datas[n])) {
      datas[n] = wtf.io.createByteArrayFromArray(datas[n]);
    } else if (goog.isString(datas[n])) {
      datas[n] = wtf.io.stringToNewByteArray(datas[n]);
    }
    contentLength += datas[n].length;
  }
  _gaq.push(['_trackEvent', 'app', 'open_snapshot', null, contentLength]);

  // TODO(benvanik): get from document? or in snapshot command?
  this.setTitle_('snapshot');

  // Create document with snapshot data.
  var doc = new wtf.doc.Document(this.platform_);
  this.openDocument(doc);

  // Append data after a bit - gives the UI time to setup.
  wtf.timing.setImmediate(function() {
    // Add all sources.
    doc.addEventSources(datas);

    // Zoom to fit.
    // TODO(benvanik): remove setTimeout when zoomToFit is based on view
    wtf.timing.setTimeout(50, function() {
      this.documentView_.zoomToFit();
    }, this);
  }, this);
};


/**
 * Handles stream create IPC commands.
 * @param {!Object} data Command data.
 * @private
 */
wtf.app.ui.MainDisplay.prototype.handleStreamCreatedCommand_ = function(data) {
  var sessionId = data['session_id'];
  var streamId = data['stream_id'] || '0';
  var contentType = data['content_type'];

  _gaq.push(['_trackEvent', 'app', 'open_stream']);

  // TODO(benvanik): get from document? or in stream command?
  this.setTitle_('streaming');

  // TODO(benvanik): support multiple streams into the same trace/etc
  var doc = new wtf.doc.Document(this.platform_);
  this.openDocument(doc);
  doc.beginEventStream(streamId, contentType);
};


/**
 * Handles stream append IPC commands.
 * @param {!Object} data Command data.
 * @private
 */
wtf.app.ui.MainDisplay.prototype.handleStreamAppendedCommand_ = function(data) {
  var sessionId = data['session_id'];
  var streamId = data['stream_id'] || '0';
  var datas = data['contents'];

  // Note that if this is not the right document the data is ignored.
  if (this.documentView_) {
    var doc = this.documentView_.getDocument();
    if (!doc.appendEventStreamData(streamId, datas)) {
      return;
    }
  }
};


/**
 * Requests a load of a trace file.
 */
wtf.app.ui.MainDisplay.prototype.requestTraceLoad = function() {
  var dom = this.getDom();
  var inputElement = dom.createElement(goog.dom.TagName.INPUT);
  inputElement['type'] = 'file';
  inputElement['multiple'] = true;
  inputElement['accept'] = [
    '.wtf-trace,application/x-extension-wtf-trace',
    '.wtf-json,application/x-extension-wtf-json',
    '.part,application/x-extension-part'
  ].join(',');
  inputElement.click();
  goog.events.listenOnce(inputElement, goog.events.EventType.CHANGE,
      function(e) {
        _gaq.push(['_trackEvent', 'app', 'open_local_files']);
        this.loadTraceFiles(inputElement.files);
      }, false, this);
};


/**
 * Loads a list of trace files.
 * Multiple files are merged into a single trace session. The name will be
 * based on the first file found.
 * @param {!Array.<!File>} traceFiles Files to load.
 */
wtf.app.ui.MainDisplay.prototype.loadTraceFiles = function(traceFiles) {
  var binarySources = [];
  var jsonSources = [];
  var filenames = [];
  for (var n = 0; n < traceFiles.length; n++) {
    var file = traceFiles[n];
    if (goog.string.endsWith(file.name, '.wtf-trace') ||
        goog.string.endsWith(file.name, '.bin.part') ||
        file.type == 'application/x-extension-wtf-trace') {
      binarySources.push(file);
      filenames.push(file.name);
    } else if (goog.string.endsWith(file.name, '.wtf-json') ||
        file.type == 'application/x-extension-wtf-json') {
      jsonSources.push(file);
      filenames.push(file.name);
    }
  }
  if (!binarySources.length && !jsonSources.length) {
    return;
  }

  // TODO(benvanik): move into wtf.analysis?
  var deferreds = [];
  for (var n = 0; n < binarySources.length; n++) {
    deferreds.push(goog.fs.FileReader.readAsArrayBuffer(binarySources[n]));
  }
  for (var n = 0; n < jsonSources.length; n++) {
    deferreds.push(goog.fs.FileReader.readAsText(jsonSources[n]));
  }
  this.openDeferredSources_(deferreds, filenames);
};


/**
 * Load trace files by url.
 * @param {!Array.<!string>} urls Array of resources to load.
 */
wtf.app.ui.MainDisplay.prototype.loadNetworkTraces = function(urls) {
  var binarySources = [];
  var jsonSources = [];
  var filenames = [];
  for (var n = 0; n < urls.length; n++) {
    var url = urls[n];
    if (goog.string.endsWith(url, '.wtf-trace') ||
        goog.string.endsWith(url, '.bin.part')) {
      binarySources.push(url);
      filenames.push(url);
    } else if (goog.string.endsWith(url, '.wtf-json')) {
      jsonSources.push(url);
      filenames.push(url);
    } else {
      wtf.ui.ErrorDialog.show(
          'Unsupported input URL',
          'Only .wtf-trace and .wtf-json inputs are supported.',
          this.getDom());
    }
  }
  if (!binarySources.length && !jsonSources.length) {
    return;
  }

  function loadUrl(url, responseType) {
    var deferred = new goog.async.Deferred();

    var xhr = new goog.net.XhrIo();
    xhr.setResponseType(responseType);
    goog.events.listen(xhr, goog.net.EventType.COMPLETE, function() {
      if (xhr.isSuccess()) {
        var data = xhr.getResponse();
        goog.asserts.assert(data);
        deferred.callback(data);
      } else {
        deferred.errback('Failed to load');
      }
    });
    xhr.send(url);

    return deferred;
  }

  var deferreds = [];
  for (var n = 0; n < binarySources.length; n++) {
    deferreds.push(loadUrl(binarySources[n],
        goog.net.XhrIo.ResponseType.ARRAY_BUFFER));
  }
  for (var n = 0; n < jsonSources.length; n++) {
    deferreds.push(loadUrl(jsonSources[n],
        goog.net.XhrIo.ResponseType.TEXT));
  }

  this.openDeferredSources_(deferreds, filenames);
};


/**
 * Requests a file load from Google Drive.
 */
wtf.app.ui.MainDisplay.prototype.requestDriveTraceLoad = function() {
  // Hide the splash dialog if it's up.
  this.showSplashDialog_(false);

  goog.result.wait(wtf.io.drive.showFilePicker({
    title: 'Select a trace file'
  }), function(filesResult) {
    var files = filesResult.getValue();
    if (!files || !files.length) {
      // Cancelled.
      // If nothing is displayed, show the splash dialog.
      if (!this.documentView_) {
        this.showSplashDialog_(true);
      }
      return;
    }

    _gaq.push(['_trackEvent', 'app', 'open_drive_files']);

    var deferreds = [];

    var filenames = [];
    for (var n = 0; n < files.length; n++) {
      var fileName = files[n][0];
      var fileId = files[n][1];
      var fileDeferred = new goog.async.Deferred();
      deferreds.push(fileDeferred);
      goog.result.wait(wtf.io.drive.downloadFile(fileId), function(result) {
        var driveFile = result.getValue();
        if (driveFile) {
          fileDeferred.callback(driveFile.contents);
          filenames.push(driveFile.filename);
        } else {
          fileDeferred.errback(result.getError());
        }
      }, this);
    }

    this.openDeferredSources_(deferreds, filenames);
  }, this);
};


/**
 * Creates a document and adds sources for a set of deferred items. Each
 * deferred should provide a ArrayBuffer of binary source data or a string
 * of json data.
 * @param {!Array.<!goog.async.Deferred>} deferreds a List of deferreds to wait
 *     on. Each should return an array buffer (for binary sources) or a string
 *     (for json sources).
 * @param {!Array.<string>} filenames File names (paths/URLs/etc allowed). This
 *     is used primarily for UI display, so they need to align to the deferreds
 *     list.
 * @private
 */
wtf.app.ui.MainDisplay.prototype.openDeferredSources_ = function(
    deferreds, filenames) {
  var doc = new wtf.doc.Document(this.platform_);
  this.openDocument(doc);

  goog.async.DeferredList.gatherResults(deferreds).addCallbacks(
      function(datas) {
        // Add all data.
        var contentLength = doc.addEventSources(datas);
        _gaq.push(['_trackEvent', 'app', 'open_files', null, contentLength]);

        // Set title.
        this.setTitleFromFilenames_(filenames);

        // Zoom to fit.
        // TODO(benvanik): remove setTimeout when zoomToFit is based on view
        wtf.timing.setTimeout(50, function() {
          this.documentView_.zoomToFit();
        }, this);
      },
      function(arg) {
        wtf.ui.ErrorDialog.show(
            'Unable to load files',
            'An input file could not be read.',
            this.getDom());
      }, this);
};


/**
 * Saves the current trace document, if any.
 * @private
 */
wtf.app.ui.MainDisplay.prototype.saveTrace_ = function() {
  if (!this.documentView_) {
    return;
  }

  var doc = this.documentView_.getDocument();
  var sources = doc.getDatabase().getSources();
  if (!sources.length) {
    return;
  }
  // Just pick the first source for naming.
  var contextInfo = sources[0].getContextInfo();
  var filename = contextInfo.getFilename();

  // prefix-YYYY-MM-DDTHH-MM-SS
  var dt = new Date();
  var filenameSuffix = '-' +
      dt.getFullYear() +
      goog.string.padNumber(dt.getMonth() + 1, 2) +
      goog.string.padNumber(dt.getDate(), 2) + 'T' +
      goog.string.padNumber(dt.getHours(), 2) +
      goog.string.padNumber(dt.getMinutes(), 2) +
      goog.string.padNumber(dt.getSeconds(), 2);
  filename += filenameSuffix;

  var storage = doc.getStorage();
  var dataStreams = storage.snapshotDataStreamBuffers();
  var contentLength = 0;
  for (var n = 0; n < dataStreams.length; n++) {
    var dataStream = dataStreams[n];
    var streamFilename = filename;
    if (dataStreams.length > 1) {
      streamFilename += '-' + n;
    }
    switch (dataStream.type) {
      case 'application/x-extension-wtf-trace':
        streamFilename += wtf.io.FILE_EXTENSION;
        break;
    }
    var platform = wtf.pal.getPlatform();
    platform.writeBinaryFile(streamFilename, dataStream.data, dataStream.type);
    contentLength += dataStream.data.length;
  }
  _gaq.push(['_trackEvent', 'app', 'save_trace', null, contentLength]);
};


/**
 * Shares the current trace document, if any.
 * @private
 */
wtf.app.ui.MainDisplay.prototype.shareTrace_ = function() {
  if (!this.documentView_) {
    return;
  }

  _gaq.push(['_trackEvent', 'app', 'share_trace']);

  // TODO(benvanik): share trace.
};


/**
 * Shows the settings dialog.
 * @private
 */
wtf.app.ui.MainDisplay.prototype.showSettings_ = function() {
  // Show settings dialog.
  var dom = this.getDom();
  var body = dom.getDocument().body;
  goog.asserts.assert(body);
  var dialog = new wtf.ui.SettingsDialog(
      this.options_, 'App Settings', body, dom);

  var panes = [
    {
      'title': 'General',
      'sections': [
        {
          'title': 'TODO',
          'widgets': [
            {
              'type': 'label',
              'title': 'Coming soon!',
              'value': ''
            }
          ]
        }
      ]
    }
  ];

  // Add extension panes.
  var extensions = wtf.ext.getAppExtensions();
  for (var n = 0; n < extensions.length; n++) {
    var manifest = extensions[n].getManifest();
    var info = extensions[n].getInfo();
    var extensionSections = [
      {
        'title': 'Info',
        'widgets': [
          {
            'type': 'label',
            'title': 'Name:',
            'value': manifest.getName()
          },
          {
            'type': 'label',
            'title': 'Source:',
            'value': manifest.getUrl()
          }
        ]
      }
    ];
    goog.array.extend(extensionSections, info.options);
    panes.push({
      'title': manifest.getName(),
      'sections': extensionSections
    });
  }

  dialog.setup({
    'panes': panes
  });

  _gaq.push(['_trackEvent', 'app', 'show_settings']);
};


/**
 * Toggles the display of the help overlay.
 * @private
 */
wtf.app.ui.MainDisplay.prototype.toggleHelpDialog_ = function() {
  // Close existing help dialog (only).
  if (this.activeDialog_) {
    if (this.activeDialog_ instanceof wtf.app.ui.HelpDialog) {
      goog.dispose(this.activeDialog_);
      this.activeDialog_ = null;
    }
    return;
  }

  // Show help dialog.
  var body = this.getDom().getDocument().body;
  goog.asserts.assert(body);
  this.activeDialog_ = new wtf.app.ui.HelpDialog(
      body,
      this.getDom());
  this.activeDialog_.addListener(wtf.ui.Dialog.EventType.CLOSED, function() {
    this.activeDialog_ = null;
  }, this);

  _gaq.push(['_trackEvent', 'app', 'show_help']);
};


/**
 * Toggles the display of the splash overlay.
 * @param {boolean} visible True to show.
 * @private
 */
wtf.app.ui.MainDisplay.prototype.showSplashDialog_ = function(visible) {
  if (this.activeDialog_) {
    if (this.activeDialog_ instanceof wtf.app.ui.SplashDialog) {
      if (visible) {
        // No-op - already visible.
        return;
      } else {
        // Hide.
        goog.dispose(this.activeDialog_);
        this.activeDialog_ = null;
      }
    } else {
      // Another kind of dialog is up - ignore.
      return;
    }
  }

  if (!visible) {
    // Already hidden, ignore.
    return;
  }

  // Show splash dialog.
  var body = this.getDom().getDocument().body;
  goog.asserts.assert(body);
  this.activeDialog_ = new wtf.app.ui.SplashDialog(
      body,
      this.getDom());
  this.activeDialog_.addListener(wtf.ui.Dialog.EventType.CLOSED, function() {
    this.activeDialog_ = null;
  }, this);
};
