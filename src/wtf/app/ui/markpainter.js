/**
 * Copyright 2012 Google, Inc. All Rights Reserved.
 *
 * Use of this source code is governed by a BSD-style license that can be
 * found in the LICENSE file.
 */

/**
 * @fileoverview Trace marker painting context.
 *
 * @author benvanik@google.com (Ben Vanik)
 */

goog.provide('wtf.app.ui.MarkPainter');

goog.require('wtf.events');
goog.require('wtf.math');
goog.require('wtf.ui.ModifierKey');
goog.require('wtf.ui.RangePainter');
goog.require('wtf.ui.color.Palette');
goog.require('wtf.util');



/**
 * Paints a ruler into the view.
 * @param {!HTMLCanvasElement} canvas Canvas element.
 * @param {!wtf.db.MarkList} markList Mark list.
 * @constructor
 * @extends {wtf.ui.RangePainter}
 */
wtf.app.ui.MarkPainter = function MarkPainter(canvas, markList) {
  goog.base(this, canvas);

  // TODO(benvanik): a better palette.
  /**
   * Color palette used for drawing marks.
   * @type {!wtf.ui.color.Palette}
   * @private
   */
  this.palette_ = new wtf.ui.color.Palette(
      wtf.app.ui.MarkPainter.MARK_COLORS_);

  /**
   * Mark list.
   * @type {wtf.db.MarkList}
   * @private
   */
  this.markList_ = markList;
};
goog.inherits(wtf.app.ui.MarkPainter, wtf.ui.RangePainter);


/**
 * Colors used for drawing marks.
 * @type {!Array.<string>}
 * @private
 * @const
 */
wtf.app.ui.MarkPainter.MARK_COLORS_ = [
  'rgb(200,200,200)',
  'rgb(189,189,189)',
  'rgb(150,150,150)',
  'rgb(130,130,130)',
  'rgb(115,115,115)',
  'rgb(100,100,100)',
  'rgb(82,82,82)'
];


/**
 * Height of the mark region, in pixels.
 * @type {number}
 * @const
 */
wtf.app.ui.MarkPainter.HEIGHT = 16;


/**
 * @override
 */
wtf.app.ui.MarkPainter.prototype.layoutInternal = function(
    availableBounds) {
  var newBounds = availableBounds.clone();
  if (this.markList_.getCount()) {
    newBounds.height = wtf.app.ui.MarkPainter.HEIGHT;
  } else {
    newBounds.height = 0;
  }
  return newBounds;
};


/**
 * @override
 */
wtf.app.ui.MarkPainter.prototype.repaintInternal = function(
    ctx, bounds) {
  var palette = this.palette_;

  // Clip to extents.
  this.clip(bounds.left, bounds.top, bounds.width, bounds.height);

  // Clear gutter.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, bounds.top, bounds.width, bounds.height);
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, bounds.top + bounds.height - 1, bounds.width, 1);

  this.beginRenderingRanges(bounds, 1);

  var timeLeft = this.timeLeft;
  var timeRight = this.timeRight;

  // Draw all visible marks.
  this.markList_.forEachIntersecting(timeLeft, timeRight, function(mark) {
    // Ignore empty marks.
    var name = mark.getName();
    if (!name || !name.length) {
      return;
    }

    // Compute screen size.
    var startTime = mark.getTime();
    var endTime = mark.getEndTime();
    var left = wtf.math.remap(startTime,
        timeLeft, timeRight,
        bounds.left, bounds.left + bounds.width);
    var right = wtf.math.remap(endTime,
        timeLeft, timeRight,
        bounds.left, bounds.left + bounds.width);
    var screenWidth = right - left;

    // Clip with the screen.
    var screenLeft = Math.max(bounds.left, left);
    var screenRight = Math.min((bounds.left + bounds.width) - 0.999, right);
    if (screenLeft >= screenRight) {
      return;
    }

    // Pick a random color.
    // We stash this on the mark so that we can ensure it's the same each draw.
    var color = /** @type {!wtf.ui.color.RgbColor} */ (mark.getRenderData());
    if (!color) {
      color = palette.getRandomColor();
      mark.setRenderData(color);
    }

    // Draw bar.
    this.drawRange(0, screenLeft, screenRight, color, 1);

    if (screenWidth > 15) {
      this.drawRangeLabel(
          bounds, left, right, screenLeft, screenRight, 0, name);
    }
  }, this);

  // Now blit the nicely rendered ranges onto the screen.
  var y = 0;
  var h = bounds.height - 1;
  this.endRenderingRanges(bounds, y, h);
};


/**
 * @override
 */
wtf.app.ui.MarkPainter.prototype.onClickInternal =
    function(x, y, modifiers, bounds) {
  var mark = this.hitTest_(x, y, bounds);
  if (mark) {
    var commandManager = wtf.events.getCommandManager();
    commandManager.execute('goto_mark', this, null, mark);
    if (modifiers & wtf.ui.ModifierKey.SHIFT) {
      commandManager.execute('select_range', this, null,
          mark.getTime(), mark.getEndTime());
    }
  }
  return true;
};


/**
 * @override
 */
wtf.app.ui.MarkPainter.prototype.getInfoStringInternal =
    function(x, y, bounds) {
  var mark = this.hitTest_(x, y, bounds);
  if (mark) {
    var lines = [
      wtf.util.formatTime(mark.getDuration()) + ': ' + mark.getName()
    ];
    var value = mark.getValue();
    wtf.util.addArgumentLines(lines, {
      'value': value !== null ? value : undefined
    });
    return lines.join('\n');
  }
  return undefined;
};


/**
 * Finds the mark at the given point.
 * @param {number} x X coordinate, relative to canvas.
 * @param {number} y Y coordinate, relative to canvas.
 * @param {!goog.math.Rect} bounds Draw bounds.
 * @return {wtf.db.Mark} Mark or nothing.
 * @private
 */
wtf.app.ui.MarkPainter.prototype.hitTest_ = function(
    x, y, bounds) {
  var time = wtf.math.remap(x,
      bounds.left, bounds.left + bounds.width,
      this.timeLeft, this.timeRight);
  return this.markList_.getMarkAtTime(time);
};
