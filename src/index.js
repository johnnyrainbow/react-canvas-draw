import { Catenary } from 'catenary-curve';
import { LazyBrush } from 'lazy-brush';
import PropTypes from 'prop-types';
import React, { PureComponent } from 'react';
import ResizeObserver from 'resize-observer-polyfill';
import CoordinateSystem, { IDENTITY } from './coordinateSystem';
import drawImage from './drawImage';
import { DefaultState, viewPointFromEvent } from './interactionStateMachine';
import makePassiveEventOption from './makePassiveEventOption';

function midPointBtw(p1, p2) {
	return {
		x: p1.x + (p2.x - p1.x) / 2,
		y: p1.y + (p2.y - p1.y) / 2,
	};
}

const canvasStyle = {
	display: 'block',
	position: 'absolute',
};

// The order of these is important: grid > drawing > temp > interface
const canvasTypes = ['grid', 'drawing', 'temp', 'interface'];

const dimensionsPropTypes = PropTypes.oneOfType([
	PropTypes.number,
	PropTypes.string,
]);

const boundsProp = PropTypes.shape({
	min: PropTypes.number.isRequired,
	max: PropTypes.number.isRequired,
});

export default class CanvasDraw extends PureComponent {
	static propTypes = {
		onChange: PropTypes.func,
		loadTimeOffset: PropTypes.number,
		lazyRadius: PropTypes.number,
		brushRadius: PropTypes.number,
		brushColor: PropTypes.string,
		catenaryColor: PropTypes.string,
		gridColor: PropTypes.string,
		backgroundColor: PropTypes.string,
		hideGrid: PropTypes.bool,
		canvasWidth: dimensionsPropTypes,
		canvasHeight: dimensionsPropTypes,
		disabled: PropTypes.bool,
		imgSrc: PropTypes.string,
		saveData: PropTypes.string,
		immediateLoading: PropTypes.bool,
		hideInterface: PropTypes.bool,
		gridSizeX: PropTypes.number,
		gridSizeY: PropTypes.number,
		gridLineWidth: PropTypes.number,
		hideGridX: PropTypes.bool,
		hideGridY: PropTypes.bool,
		enablePanAndZoom: PropTypes.bool,
		mouseZoomFactor: PropTypes.number,
		zoomExtents: boundsProp,
		clampLinesToDocument: PropTypes.bool,
		trueMouseDown: PropTypes.bool,
		tool: PropTypes.string,
		fillShape: PropTypes.bool,
		pencilIcon: PropTypes.any,
		eraserIcon: PropTypes.any,
		bucketIcon: PropTypes.any,
		crosshairIcon: PropTypes.any,
	};

	static defaultProps = {
		onChange: null,
		loadTimeOffset: 5,
		lazyRadius: 0,
		brushRadius: 10,
		brushColor: '#db2727',
		catenaryColor: '#0a0302',
		gridColor: 'rgba(150,150,150,0.17)',
		backgroundColor: '#FFF',
		hideGrid: false,
		canvasWidth: 400,
		canvasHeight: 400,
		disabled: false,
		imgSrc: '',
		saveData: '',
		immediateLoading: false,
		hideInterface: false,
		gridSizeX: 25,
		gridSizeY: 25,
		gridLineWidth: 0.5,
		hideGridX: false,
		hideGridY: false,
		enablePanAndZoom: false,
		mouseZoomFactor: 0.01,
		zoomExtents: { min: 0.33, max: 3 },
		clampLinesToDocument: false,
		trueMouseDown: false,
		tool: '',
		fillShape: false,
		pencilIcon: null,
		eraserIcon: null,
		bucketIcon: null,
		crosshairIcon: null,
	};

	///// public API /////////////////////////////////////////////////////////////

	constructor(props) {
		super(props);

		this.canvas = {};
		this.ctx = {};

		this.catenary = new Catenary();
		this.circles = [];
		this.rectangles = [];
		this.points = [];
		this.allDrawnPoints = [];
		this.lines = [];
		this.erasedLines = [];
		this.shapeStartX;
		this.shapeStartY;
		this.lastX;
		this.lastY;
		this.mouseX;
		this.mouseY;
		this.mouseHasMoved = true;
		this.valuesChanged = true;
		this.isDrawing = false;
		this.isPressing = false;
		this.deferRedrawOnViewChange = false;
		this.undoImageQueue = [];

		this.interactionSM = new DefaultState();
		this.coordSystem = new CoordinateSystem({
			scaleExtents: props.zoomExtents,
			documentSize: { width: props.canvasWidth, height: props.canvasHeight },
		});
		this.coordSystem.attachViewChangeListener(this.applyView.bind(this));
	}

	pushToUndoQueue = () => {
		const imageData = this.ctx.drawing.getImageData(
			0,
			0,
			this.ctx.drawing.canvas.width,
			this.ctx.drawing.canvas.height
		);
		if (this.undoImageQueue.length >= 6) { //max 6 stacks undo
			this.undoImageQueue.pop();
		}
		this.undoImageQueue.push(imageData);
	};
	undo = () => {
		console.log('hit undo');
		if (this.undoImageQueue.length > 0) {
			console.log('popping!');
			const image = this.undoImageQueue.pop();
			console.log('image ' + image);
			this.imageData = image;
			this.loadSaveData();
		} else {
			console.log('NO UNDO DATA :(');
		}
		// let lines = [];
		// if (this.lines.length) {
		// 	lines = this.lines.slice(0, -1);
		// } else if (this.erasedLines.length) {
		// 	lines = this.erasedLines.pop();
		// }
		// this.clearExceptErasedLines();
		// this.simulateDrawingLines({ lines, immediate: true });
		// this.triggerOnChange();
	};

	eraseAll = () => {
		this.erasedLines.push([...this.lines]);
		this.clearExceptErasedLines();
		this.triggerOnChange();
	};

	clear = () => {
		this.erasedLines = [];
		this.clearExceptErasedLines();
		this.resetView();
	};

	resetView = () => {
		return this.coordSystem.resetView();
	};

	setView = (view) => {
		return this.coordSystem.setView(view);
	};

	getSaveData = () => {
		// Construct and return the stringified saveData object
		return JSON.stringify({
			lines: this.lines,
			width: this.props.canvasWidth,
			height: this.props.canvasHeight,
		});
	};

	/**
   * Combination of work by Ernie Arrowsmith and emizz
   * References:
   * https://stackoverflow.com/questions/32160098/change-html-canvas-black-background-to-white-background-when-creating-jpg-image
   * https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/toDataURL

   * This function will export the canvas to a data URL, which can subsequently be used to share or manipulate the image file.
   * @param {string} fileType Specifies the file format to export to. Note: should only be the file type, not the "image/" prefix.
   *  For supported types see https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/toDataURL
   * @param {bool} useBgImage Specifies whether the canvas' current background image should also be exported. Default is false.
   * @param {string} backgroundColour The desired background colour hex code, e.g. "#ffffff" for white.
   */
	getDataURL = (fileType, useBgImage, backgroundColour) => {
		// Get a reference to the "drawing" layer of the canvas
		let canvasToExport = this.canvas.drawing;
		const imageData1 = this.ctx.drawing.getImageData(
			0,
			0,
			this.ctx.drawing.canvas.width,
			this.ctx.drawing.canvas.height
		);
		this.white2transparent(this.ctx.drawing, imageData1);
		let context = canvasToExport.getContext('2d');

		//cache height and width
		let width = canvasToExport.width;
		let height = canvasToExport.height;

		//get the current ImageData for the canvas
		let storedImageData = context.getImageData(0, 0, width, height);

		//store the current globalCompositeOperation
		var compositeOperation = context.globalCompositeOperation;

		//set to draw behind current content
		context.globalCompositeOperation = 'destination-over';

		// If "useBgImage" has been set to true, this takes precedence over the background colour parameter
		if (useBgImage) {
			if (!this.props.imgSrc) return 'Background image source not set';

			// Write the background image
			this.drawImage();
		} else if (backgroundColour != null) {
			//set background color
			context.fillStyle = backgroundColour;

			//fill entire canvas with background colour
			context.fillRect(0, 0, width, height);
		}

		// If the file type has not been specified, default to PNG
		if (!fileType) fileType = 'png';

		// Export the canvas to data URL
		let imageData = canvasToExport.toDataURL(`image/${fileType}`);

		//clear the canvas
		context.clearRect(0, 0, width, height);

		//restore it with original / cached ImageData
		context.putImageData(storedImageData, 0, 0);

		//reset the globalCompositeOperation to what it was
		context.globalCompositeOperation = compositeOperation;

		return imageData;
	};
	scaleImageData(c, imageData, scale) {
		console.log('SCALE IS ' + scale);
		var scaled = c.createImageData(
			imageData.width * scale,
			imageData.height * scale
		);

		for (var row = 0; row < imageData.height; row++) {
			for (var col = 0; col < imageData.width; col++) {
				var sourcePixel = [
					imageData.data[(row * imageData.width + col) * 4 + 0],
					imageData.data[(row * imageData.width + col) * 4 + 1],
					imageData.data[(row * imageData.width + col) * 4 + 2],
					imageData.data[(row * imageData.width + col) * 4 + 3],
				];
				for (var y = 0; y < scale; y++) {
					var destRow = row * scale + y;
					for (var x = 0; x < scale; x++) {
						var destCol = col * scale + x;
						for (var i = 0; i < 4; i++) {
							scaled.data[(destRow * scaled.width + destCol) * 4 + i] =
								sourcePixel[i];
						}
					}
				}
			}
		}

		return scaled;
	}

	white2transparent(context, imgData) {
		let pix = imgData.data;

		// Loops through all of the pixels and modifies the components.
		for (var i = 0, n = pix.length; i < n; i += 4) {
			if (pix[i] == 255 && pix[i + 1] == 255 && pix[i + 2] == 255) {
				//pixel is white
				pix[i + 3] = 0;
				// console.log("FOUND WHITE PIXELS")
			} else {
				//pixel is not white, modify it.
				// console.log("NOP  WHITE PIXELS")
			}
			//pix[i+3] is the transparency.
		}

		context.putImageData(imgData, 0, 0);
	}
	loadSaveData = (saveData, immediate = true) => {
		this.clear();
		if (!this.imageData) return;

		this.ctx.drawing.putImageData(this.imageData, 0, 0);
		const pointer = this.lazy.getPointerCoordinates();
		// this.drawInterface(this.ctx.interface, { x: this.lastX, y: this.lastY, gab: true });
		return;

		if (typeof saveData !== 'string') {
			throw new Error('saveData needs to be of type string!');
		}

		const { lines, width, height } = JSON.parse(saveData);

		if (!lines || typeof lines.push !== 'function') {
			throw new Error('saveData.lines needs to be an array!');
		}
		const imageData = this.ctx.drawing.getImageData(
			0,
			0,
			this.ctx.drawing.canvas.width,
			this.ctx.drawing.canvas.height
		);
		this.clear();
		if (this.imageData) this.ctx.drawing.putImageData(imageData, 0, 0);
		if (
			width === this.props.canvasWidth &&
			height === this.props.canvasHeight
		) {
			this.simulateDrawingLines({
				lines,
				immediate,
			});
		} else {
			// we need to rescale the lines based on saved & current dimensions
			const scaleX = this.props.canvasWidth / width;
			const scaleY = this.props.canvasHeight / height;
			const scaleAvg = (scaleX + scaleY) / 2;

			this.simulateDrawingLines({
				lines: lines.map((line) => ({
					...line,
					points: line.points.map((p) => ({
						x: p.x * scaleX,
						y: p.y * scaleY,
					})),
					brushRadius: line.brushRadius * scaleAvg,
				})),
				immediate,
			});
		}

		//	this.reDrawShapes();
	};

	///// private API ////////////////////////////////////////////////////////////

	///// React Lifecycle

	componentDidMount() {
		this.lazy = new LazyBrush({
			radius: this.props.lazyRadius * window.devicePixelRatio,
			enabled: true,
			initialPoint: {
				x: window.innerWidth / 2,
				y: window.innerHeight / 2,
			},
		});
		this.chainLength = this.props.lazyRadius * window.devicePixelRatio;

		this.canvasObserver = new ResizeObserver((entries, observer) =>
			this.handleCanvasResize(entries, observer)
		);
		this.canvasObserver.observe(this.canvasContainer);

		this.drawImage();
		this.loop();

		window.setTimeout(() => {
			const initX = window.innerWidth / 2;
			const initY = window.innerHeight / 2;
			this.lazy.update(
				{ x: initX - this.chainLength / 4, y: initY },
				{ both: true }
			);
			this.lazy.update(
				{ x: initX + this.chainLength / 4, y: initY },
				{ both: false }
			);
			this.mouseHasMoved = true;
			this.valuesChanged = true;
			this.clearExceptErasedLines();

			// Load saveData from prop if it exists
			if (this.props.saveData) {
				this.loadSaveData(this.props.saveData);
			}
		}, 100);

		// Attach our wheel event listener here instead of in the render so that we can specify a non-passive listener.
		// This is necessary to prevent the default event action on chrome.
		// https://github.com/facebook/react/issues/14856
		this.canvas.interface &&
			this.canvas.interface.addEventListener(
				'wheel',
				this.handleWheel,
				makePassiveEventOption()
			);
	}

	componentDidUpdate(prevProps) {
		console.log('PROP UPDATE MOUSEDOWN ' + this.props.trueMouseDown);
		if (prevProps.lazyRadius !== this.props.lazyRadius) {
			// Set new lazyRadius values
			this.chainLength = this.props.lazyRadius * window.devicePixelRatio;
			this.lazy.setRadius(this.props.lazyRadius * window.devicePixelRatio);
		}

		if (prevProps.saveData !== this.props.saveData) {
			this.loadSaveData(this.props.saveData);
		}

		if (JSON.stringify(prevProps) !== JSON.stringify(this.props)) {
			// Signal this.loop function that values changed
			this.valuesChanged = true;
		}

		this.coordSystem.scaleExtents = this.props.zoomExtents;
		if (!this.props.enablePanAndZoom) {
			this.coordSystem.resetView();
		}

		if (prevProps.imgSrc !== this.props.imgSrc) {
			this.drawImage();
		}
		// console.log("IMG URL " + this.getDataURL('png', false, null));
	}

	componentWillUnmount = () => {
		this.canvasObserver.unobserve(this.canvasContainer);
		this.canvas.interface &&
			this.canvas.interface.removeEventListener('wheel', this.handleWheel);
	};

	render() {
		return (
			<div
				className={this.props.className}
				style={{
					display: 'block',
					background: this.props.backgroundColor,
					touchAction: 'none',
					width: this.props.canvasWidth,
					height: this.props.canvasHeight,
					...this.props.style,
				}}
				ref={(container) => {
					if (container) {
						this.canvasContainer = container;
					}
				}}
			>
				{canvasTypes.map((name) => {
					const isInterface = name === 'interface';
					return (
						<canvas
							key={name}
							ref={(canvas) => {
								if (canvas) {
									this.canvas[name] = canvas;
									this.ctx[name] = canvas.getContext('2d');
									if (isInterface) {
										this.coordSystem.canvas = canvas;
									}
								}
							}}
							style={{ ...canvasStyle }}
							onMouseDown={isInterface ? this.handleMouseDown : undefined}
							onMouseMove={isInterface ? this.handleDrawMove : undefined}
							onMouseUp={isInterface ? this.handleMouseUp : undefined}
							onMouseOut={isInterface ? this.handleMouseOut : undefined}
							onMouseOver={isInterface ? this.handleMouseOver : undefined} //gab additional listener
							onTouchStart={isInterface ? this.handleDrawStart : undefined}
							onTouchMove={isInterface ? this.handleDrawMove : undefined}
							onTouchEnd={isInterface ? this.handleDrawEnd : undefined}
							onTouchCancel={isInterface ? this.handleDrawEnd : undefined}
						/>
					);
				})}
			</div>
		);
	}
	handleMouseOut = (e) => {
		//we want to end the draw regardless. but mouse down should still be true. check it when we come back in, and know to restart the drawing
		this.handleDrawEnd(e);
	};

	handleMouseOver = (e) => {
		console.log('TRUE MOUSE STATE ' + this.props.trueMouseDown);
		if (this.props.trueMouseDown) {
			let clientX = e.clientX;
			let clientY = e.clientY;
			console.log('XY ' + clientX, clientY);
			const shouldStartAtEdge = true;
			this.handleDrawStart(e, shouldStartAtEdge);
		}
	};
	handleMouseDown = (e) => {
		console.log('SET MOUSE DOWN');
		let { x, y } = viewPointFromEvent(this.coordSystem, e);
		if (this.props.tool === 'FloodFill') {
			// get 2d context
			const context = this.ctx.drawing;
			// get image data
			this.floodFill(
				context,
				Math.round(x),
				Math.round(y),
				this.props.brushColor
			);
		}

		if (this.props.tool === 'Rectangle' || this.props.tool === 'Circle') {
			this.isDrawingShape = true;
			console.log('ok');
			console.log('Start x at ' + x);
			this.shapeStartX = x;
			this.shapeStartY = y;
		}
		// this.isMouseDown = true;
		this.handleDrawStart(e);
	};
	handleMouseUp = (e) => {
		console.log('GOT IMAGE DATA');
		if (this.isDrawingShape) {
			this.lazy.update({ x: this.lastX, y: this.lastY });
		}

		this.isDrawingShape = false;
		if (this.props.tool === 'Rectangle') {
			this.rectangles.push({
				shape: {
					x: this.shapeStartX,
					y: this.shapeStartY,
					width: this.lastX - this.shapeStartX,
					height: this.lastY - this.shapeStartY,
				},
				brushColor: this.props.brushColor,
				brushRadius: this.props.brushRadius,
				fillShape: this.props.fillShape,
			});
		}
		if (this.props.tool === 'Circle') {
			const radius = Math.abs(this.lastX - this.shapeStartX);
			this.circles.push({
				shape: {
					x: this.shapeStartX + radius / 2,
					y: this.shapeStartY + radius / 2,
					radius,
				},
				brushColor: this.props.brushColor,
				brushRadius: this.props.brushRadius,
				fillShape: this.props.fillShape,
			});
		}
		console.log('SET MOUSE UP');
		// this.isMouseDown = false;
		this.handleDrawEnd(e);
		this.pushToUndoQueue();
		const imageData = this.ctx.drawing.getImageData(
			0,
			0,
			this.ctx.drawing.canvas.width,
			this.ctx.drawing.canvas.height
		);
		this.imageData = imageData;
	};

	///// Event Handlers

	handleWheel = (e) => {
		this.interactionSM = this.interactionSM.handleMouseWheel(e, this);
	};

	handleDrawStart = (e, shouldStartAtEdge) => {
		console.log('mouse down draw');

		this.interactionSM = this.interactionSM.handleDrawStart(
			e,
			this,
			shouldStartAtEdge
		);
		this.mouseHasMoved = true;
	};

	handleDrawMove = (e) => {
		this.interactionSM = this.interactionSM.handleDrawMove(e, this);
		this.mouseHasMoved = true;
	};

	handleDrawEnd = (e) => {
		this.interactionSM = this.interactionSM.handleDrawEnd(e, this);
		this.mouseHasMoved = true;
	};

	applyView = () => {
		if (!this.ctx.drawing) {
			console.log('??');
			return;
		}
		console.log('APPLYING VIEW');
		canvasTypes
			.map((name) => this.ctx[name])
			.forEach((ctx) => {
				this.clearWindow(ctx);
				const m = this.coordSystem.transformMatrix;
				ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
			});

		if (!this.deferRedrawOnViewChange) {
			this.drawGrid(this.ctx.grid);
			this.redrawImage();
			this.loop({ once: true });

			const lines = this.lines;
			this.lines = [];
			this.simulateDrawingLines({ lines, immediate: true });
		}
	};

	handleCanvasResize = (entries) => {
		const saveData = this.getSaveData();
		this.deferRedrawOnViewChange = true;
		try {
			for (const entry of entries) {
				const { width, height } = entry.contentRect;
				this.setCanvasSize(this.canvas.interface, width, height);
				this.setCanvasSize(this.canvas.drawing, width, height);
				this.setCanvasSize(this.canvas.temp, width, height);
				this.setCanvasSize(this.canvas.grid, width, height);

				this.coordSystem.documentSize = { width, height };
				this.drawGrid(this.ctx.grid);
				this.drawImage();
				this.loop({ once: true });
			}
			this.loadSaveData(saveData, true);
		} finally {
			this.deferRedrawOnViewChange = false;
		}
	};

	///// Helpers

	clampPointToDocument = (point) => {
		if (this.props.clampLinesToDocument) {
			return {
				x: Math.max(Math.min(point.x, this.props.canvasWidth), 0),
				y: Math.max(Math.min(point.y, this.props.canvasHeight), 0),
			};
		} else {
			return point;
		}
	};

	redrawImage = () => {
		this.image &&
			this.image.complete &&
			drawImage({ ctx: this.ctx.grid, img: this.image });
	};

	simulateDrawingLines = ({ lines, immediate }) => {
		// Simulate live-drawing of the loaded lines
		// TODO use a generator
		let curTime = 0;
		let timeoutGap = immediate ? 0 : this.props.loadTimeOffset;

		lines.forEach((line) => {
			const { points, brushColor, brushRadius } = line;

			// Draw all at once if immediate flag is set, instead of using setTimeout
			if (immediate) {
				// Draw the points
				this.drawPoints({
					points,
					brushColor,
					brushRadius,
				});

				// Save line with the drawn points
				this.points = points;
				this.saveLine({ brushColor, brushRadius });
				return;
			}

			// Use timeout to draw
			for (let i = 1; i < points.length; i++) {
				curTime += timeoutGap;
				window.setTimeout(() => {
					this.drawPoints({
						points: points.slice(0, i + 1),
						brushColor,
						brushRadius,
					});
				}, curTime);
			}

			curTime += timeoutGap;
			window.setTimeout(() => {
				// Save this line with its props instead of this.props
				this.points = points;
				this.saveLine({ brushColor, brushRadius });
			}, curTime);
		});
	};

	setCanvasSize = (canvas, width, height) => {
		canvas.width = width;
		canvas.height = height;
		canvas.style.width = width;
		canvas.style.height = height;
	};

	drawPoints = ({ points, brushColor, brushRadius }) => {
		this.ctx.temp.lineJoin = 'round';
		this.ctx.temp.lineCap = 'round';

		if (this.props.type === 'eraser') {
			this.ctx.temp.lineJoin = 'miter';
			this.ctx.temp.lineCap = 'butt';
		}
		this.ctx.temp.strokeStyle = brushColor;

		this.clearWindow(this.ctx.temp);
		this.ctx.temp.lineWidth = brushRadius * 2;

		let p1 = points[0];
		let p2 = points[1];

		this.ctx.temp.moveTo(p2.x, p2.y);
		this.ctx.temp.beginPath();

		for (var i = 1, len = points.length; i < len; i++) {
			// we pick the point between pi+1 & pi+2 as the
			// end point and p1 as our control point
			var midPoint = midPointBtw(p1, p2);
			this.ctx.temp.quadraticCurveTo(p1.x, p1.y, midPoint.x, midPoint.y);
			p1 = points[i];
			p2 = points[i + 1];
		}
		// Draw last line as a straight line while
		// we wait for the next point to be able to calculate
		// the bezier control point
		this.ctx.temp.lineTo(p1.x, p1.y);
		this.ctx.temp.stroke();
	};

	drawRect = () => {
		const saveData = this.getSaveData();
		this.loadSaveData(saveData);
		this.ctx.drawing.beginPath();
		this.ctx.drawing.strokeStyle = this.props.brushColor;
		this.ctx.drawing.lineWidth = this.props.brushRadius;
		if (this.props.fillShape) {
			this.ctx.drawing.fillStyle = this.props.brushColor;
			this.ctx.drawing.fillRect(
				this.shapeStartX,
				this.shapeStartY,
				this.lastX - this.shapeStartX,
				this.lastY - this.shapeStartY
			);
		} else {
			this.ctx.drawing.rect(
				this.shapeStartX,
				this.shapeStartY,
				this.lastX - this.shapeStartX,
				this.lastY - this.shapeStartY
			);
		}
		this.ctx.drawing.stroke();
		this.ctx.drawing.closePath();
	};

	drawCircle = () => {
		const saveData = this.getSaveData();
		this.loadSaveData(saveData);

		this.ctx.drawing.beginPath();

		this.ctx.drawing.strokeStyle = this.props.brushColor;
		if (this.props.fillShape)
			this.ctx.drawing.fillStyle = this.props.brushColor;
		this.ctx.drawing.lineWidth = this.props.brushRadius;
		const radius = Math.abs(this.lastX - this.shapeStartX);
		this.ctx.drawing.arc(
			this.shapeStartX + radius / 2,
			this.shapeStartY + radius / 2,
			radius,
			0,
			2 * Math.PI
		);
		if (this.props.fillShape) this.ctx.drawing.fill();
		this.ctx.drawing.stroke();
		this.ctx.drawing.closePath();
	};

	reDrawShapes = () => {
		for (const circle of this.circles) {
			const { shape, brushColor, brushRadius, fillShape } = circle;
			const { x, y, radius } = shape;
			this.ctx.drawing.beginPath();
			this.ctx.drawing.strokeStyle = brushColor;
			this.ctx.drawing.lineWidth = brushRadius;
			if (fillShape) this.ctx.drawing.fillStyle = brushColor;

			this.ctx.drawing.arc(x, y, radius, 0, 2 * Math.PI);
			this.ctx.drawing.stroke();
			if (fillShape) this.ctx.drawing.fill();
			this.ctx.drawing.closePath();
		}
		for (const rectangle of this.rectangles) {
			const { shape, brushColor, brushRadius, fillShape } = rectangle;
			const { x, y, width, height } = shape;
			this.ctx.drawing.beginPath();
			this.ctx.drawing.strokeStyle = brushColor;
			this.ctx.drawing.lineWidth = brushRadius;
			if (fillShape) {
				this.ctx.drawing.fillStyle = brushColor;
				this.ctx.drawing.fillRect(x, y, width, height);
			} else {
				this.ctx.drawing.rect(x, y, width, height);
			}

			this.ctx.drawing.stroke();
			this.ctx.drawing.closePath();
		}
	};

	saveLine = ({ brushColor, brushRadius } = {}) => {
		if (this.points.length < 2) return;

		// Save as new line
		this.lines.push({
			points: [...this.points],
			brushColor: brushColor || this.props.brushColor,
			brushRadius: brushRadius || this.props.brushRadius,
		});

		// Reset points array
		this.points.length = 0;

		// Copy the line to the drawing canvas
		this.inClientSpace([this.ctx.drawing, this.ctx.temp], () => {
			this.ctx.drawing.drawImage(
				this.canvas.temp,
				0,
				0,
				this.canvas.drawing.width,
				this.canvas.drawing.height
			);
		});

		// Clear the temporary line-drawing canvas
		this.clearWindow(this.ctx.temp);

		this.triggerOnChange();
	};

	triggerOnChange = () => {
		this.props.onChange && this.props.onChange(this);
	};

	clearWindow = (ctx) => {
		this.inClientSpace([ctx], () =>
			ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height)
		);
	};

	clearExceptErasedLines = () => {
		this.lines = [];
		this.valuesChanged = true;
		this.clearWindow(this.ctx.drawing);
		this.clearWindow(this.ctx.temp);
	};

	loop = ({ once = false } = {}) => {
		if (this.mouseHasMoved || this.valuesChanged) {
			const pointer = this.lazy.getPointerCoordinates();
			const brush = this.lazy.getBrushCoordinates();

			this.drawInterface(this.ctx.interface, pointer, brush);
			this.mouseHasMoved = false;
			this.valuesChanged = false;
		}

		if (!once) {
			window.requestAnimationFrame(() => {
				this.loop();
			});
		}
	};

	inClientSpace = (ctxs, action) => {
		ctxs.forEach((ctx) => {
			ctx.save();
			ctx.setTransform(
				IDENTITY.a,
				IDENTITY.b,
				IDENTITY.c,
				IDENTITY.d,
				IDENTITY.e,
				IDENTITY.f
			);
		});

		try {
			action();
		} finally {
			ctxs.forEach((ctx) => ctx.restore());
		}
	};

	///// Canvas Rendering

	drawImage = () => {
		if (!this.props.imgSrc) return;

		// Load the image
		this.image = new Image();

		// Prevent SecurityError "Tainted canvases may not be exported." #70
		this.image.crossOrigin = 'anonymous';

		// Draw the image once loaded
		this.image.onload = this.redrawImage;
		this.image.src = this.props.imgSrc;
	};

	drawGrid = (ctx) => {
		if (this.props.hideGrid) return;

		this.clearWindow(ctx);

		const gridSize = 25;
		const { viewMin, viewMax } = this.coordSystem.canvasBounds;
		const minx = Math.floor(viewMin.x / gridSize - 1) * gridSize;
		const miny = Math.floor(viewMin.y / gridSize - 1) * gridSize;
		const maxx = viewMax.x + gridSize;
		const maxy = viewMax.y + gridSize;

		ctx.beginPath();
		ctx.setLineDash([5, 1]);
		ctx.setLineDash([]);
		ctx.strokeStyle = this.props.gridColor;
		ctx.lineWidth = this.props.gridLineWidth;

		if (!this.props.hideGridX) {
			let countX = minx;
			const gridSizeX = this.props.gridSizeX;
			while (countX < maxx) {
				countX += gridSizeX;
				ctx.moveTo(countX, miny);
				ctx.lineTo(countX, maxy);
			}
			ctx.stroke();
		}

		if (!this.props.hideGridY) {
			let countY = miny;
			const gridSizeY = this.props.gridSizeY;
			while (countY < maxy) {
				countY += gridSizeY;
				ctx.moveTo(minx, countY);
				ctx.lineTo(maxx, countY);
			}
			ctx.stroke();
		}
	};

	drawInterface = (ctx, pointer) => {
		if (this.props.hideInterface) return;

		this.clearWindow(ctx);

		// Draw brush preview
		ctx.beginPath();
		ctx.fillStyle = this.props.brushColor;

		// let base_image = new Image();

		// base_image.src = this.props.crosshairIcon;
		// base_image.onload = function(){
		const crosshairDim = 15;
		ctx.lineWidth = 2;
		if (this.isDrawingShape) pointer.x = this.lastX;
		if (this.isDrawingShape) pointer.y = this.lastY;

		ctx.moveTo(pointer.x - crosshairDim, pointer.y);
		ctx.lineTo(pointer.x + crosshairDim, pointer.y);

		ctx.moveTo(pointer.x, pointer.y - crosshairDim);
		ctx.lineTo(pointer.x, pointer.y + crosshairDim);
		ctx.stroke();
		// ctx.drawImage(base_image, pointer.x, pointer.y - 50, 50, 50);
		// if(pointer.gab)
		console.log('Drawing cursor at ', pointer.x, pointer.y);
	};

	cssTo32BitColor = (function () {
		let ctx;
		return function (cssColor) {
			if (!ctx) {
				ctx = document.createElement('canvas').getContext('2d');
				ctx.canvas.width = 1;
				ctx.canvas.height = 1;
			}
			ctx.clearRect(0, 0, 1, 1);
			ctx.fillStyle = cssColor;
			ctx.fillRect(0, 0, 1, 1);
			const imgData = ctx.getImageData(0, 0, 1, 1);
			return new Uint32Array(imgData.data.buffer)[0];
		};
	})();
	getIsLittleEndian = (function () {
		var isLittleEndian = true;
		return function () {
			var buf = new ArrayBuffer(4);
			var buf8 = new Uint8ClampedArray(buf);
			var data = new Uint32Array(buf);
			data[0] = 0x0f000000;
			if (buf8[0] === 0x0f) {
				isLittleEndian = false;
			}
			return isLittleEndian;
		};
	})();
	reverseUint32(uint32) {
		var s32 = new Uint32Array(4);
		var s8 = new Uint8Array(s32.buffer);
		var t32 = new Uint32Array(4);
		var t8 = new Uint8Array(t32.buffer);
		const reverseUint32e = function (x) {
			s32[0] = x;
			t8[0] = s8[3];
			t8[1] = s8[2];
			t8[2] = s8[1];
			t8[3] = s8[0];
			return t32[0];
		};
		return reverseUint32e(uint32);
	}
	hexToRgb(hex) {
		var result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
		return result
			? {
					r: parseInt(result[1], 16),
					g: parseInt(result[2], 16),
					b: parseInt(result[3], 16),
			  }
			: null;
	}
	isGrey = function (rgb) {
		if (!rgb) return false;

		const { r, g, b } = rgb;
		if (r >= 204 && g >= 204 && b >= 204 && r === g && g === b) {
			console.log('GREY FILLED');
			return true;
		}
		return false;
	};

	floodFillImage() {}

	floodFill(ctx, x, y, fillColor) {
		fillColor = this.cssTo32BitColor(fillColor);
		function getPixel(pixelData, x, y) {
			if (x < 0 || y < 0 || x >= pixelData.width || y >= pixelData.height) {
				return -1; // impossible color
			} else {
				return pixelData.data[y * pixelData.width + x];
			}
		}
		// read the pixels in the canvas
		const imageData = ctx.getImageData(
			0,
			0,
			this.ctx.drawing.canvas.width,
			this.ctx.drawing.canvas.height
		);

		// this.white2transparent(this.ctx.drawing, imageData);

		// make a Uint32Array view on the pixels so we can manipulate pixels
		// one 32bit value at a time instead of as 4 bytes per pixel
		const pixelData = {
			width: imageData.width,
			height: imageData.height,
			data: new Uint32Array(imageData.data.buffer),
		};

		// get the color we're filling
		// console.log(this.getIsLittleEndian());
		const targetColor = getPixel(pixelData, x, y);

		// check we are actually filling a different color
		console.log('TARGET VS FILL ' + targetColor, fillColor);
		if (targetColor !== fillColor) {
			const pixelsToCheck = [x, y];
			while (pixelsToCheck.length > 0) {
				const y = pixelsToCheck.pop();
				const x = pixelsToCheck.pop();

				const currentColor = getPixel(pixelData, x, y);

				let rgb = null;
				// if (this.getIsLittleEndian()) {
				//   // console.log(targetColor.toString(16));
				//   // console.log(this.reverseUint32(targetColor).toString(16));
				//   const conv = this.reverseUint32(currentColor).toString(16);
				//   const hex = conv.slice(0, conv.length - 2);

				//   rgb = this.hexToRgb(`#${hex}`);
				// }

				if (currentColor === targetColor) {
					pixelData.data[y * pixelData.width + x] = fillColor;

					pixelsToCheck.push(x + 1, y);
					pixelsToCheck.push(x - 1, y);
					pixelsToCheck.push(x, y + 1);
					pixelsToCheck.push(x, y - 1);
				}
			}
			// put the data back
			this.imageData = imageData;
			this.pushToUndoQueue();
			ctx.putImageData(imageData, 0, 0);
		}
	}
}
