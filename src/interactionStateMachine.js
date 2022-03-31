import FloodFill from './FloodFill';

const TOUCH_SLOP = 10;
const PINCH_TIMEOUT_MS = 250;
const SUPPRESS_SCROLL = (e) => {
	// No zooming while drawing, but we'll cancel the scroll event.
	e.preventDefault();
	return this;
};

/**
 * The default state for the interaction state machine. Supports zoom and
 * initiating pan and drawing actions.
 */
export class DefaultState {
	handleMouseWheel = (e, canvasDraw) => {
		const { disabled, enablePanAndZoom, mouseZoomFactor } = canvasDraw.props;
		if (disabled) {
			return new DisabledState();
		} else if (enablePanAndZoom && e.ctrlKey) {
			e.preventDefault();
			canvasDraw.coordSystem.scaleAtClientPoint(
				mouseZoomFactor * e.deltaY,
				clientPointFromEvent(e)
			);
		}
		return this;
	};

	handleDrawStart = (e, canvasDraw, shouldStartAtEdge) => {
		if (canvasDraw.props.disabled) {
			return new DisabledState();
		} else if (e.ctrlKey && canvasDraw.props.enablePanAndZoom) {
			return new PanState().handleDrawStart(e, canvasDraw);
		} else {
			return new WaitForPinchState().handleDrawStart(
				e,
				canvasDraw,
				shouldStartAtEdge
			);
		}
	};

	handleDrawMove = (e, canvasDraw) => {
		if (canvasDraw.props.disabled) {
			return new DisabledState();
		} else {
			const { x, y } = viewPointFromEvent(canvasDraw.coordSystem, e);

			canvasDraw.lazy.update({ x, y });
			return this;
		}
	};

	handleDrawEnd = (e, canvasDraw) => {
		return canvasDraw.props.disabled ? new DisabledState() : this;
	};
}

/**
 * This state is used as long as the disabled prop is active. It ignores all
 * events and doesn't prevent default actions. The disabled state can only be
 * triggered from the default state (i.e., while no action is actively being
 * performed).
 */
export class DisabledState {
	handleMouseWheel = (e, canvasDraw) => {
		if (canvasDraw.props.disabled) {
			return this;
		} else {
			return new DefaultState().handleMouseWheel(e, canvasDraw);
		}
	};

	handleDrawStart = (e, canvasDraw) => {
		if (canvasDraw.props.disabled) {
			return this;
		} else {
			return new DefaultState().handleDrawStart(e, canvasDraw);
		}
	};

	handleDrawMove = (e, canvasDraw) => {
		if (canvasDraw.props.disabled) {
			return this;
		} else {
			return new DefaultState().handleDrawMove(e, canvasDraw);
		}
	};

	handleDrawEnd = (e, canvasDraw) => {
		if (canvasDraw.props.disabled) {
			return this;
		} else {
			return new DefaultState().handleDrawEnd(e, canvasDraw);
		}
	};
}

/**
 * This state is active as long as the user is panning the image. This state is
 * retained until the pan ceases.
 */
export class PanState {
	handleMouseWheel = SUPPRESS_SCROLL.bind(this);

	handleDrawStart = (e, canvasDraw) => {
		e.preventDefault();

		this.dragStart = clientPointFromEvent(e);
		this.panStart = {
			x: canvasDraw.coordSystem.x,
			y: canvasDraw.coordSystem.y,
		};

		return this;
	};

	handleDrawMove = (e, canvasDraw) => {
		e.preventDefault();

		const { clientX, clientY } = clientPointFromEvent(e);
		const dx = clientX - this.dragStart.clientX;
		const dy = clientY - this.dragStart.clientY;
		canvasDraw.coordSystem.setView({
			x: this.panStart.x + dx,
			y: this.panStart.y + dy,
		});

		return this;
	};

	handleDrawEnd = () => new DefaultState();
}

/**
 * This state is active when the user has initiated the drawing action but has
 * not yet created any lines. We use this state to try and detect a second touch
 * event to initiate a pinch-zoom action. We'll give up on that if enough time
 * or movement happens without a second touch.
 */
export class WaitForPinchState {
	constructor() {
		this.startClientPoint = null;
		this.startTimestamp = new Date().valueOf();
		this.deferredPoints = [];
	}

	handleMouseWheel = SUPPRESS_SCROLL.bind(this);

	handleDrawStart = (e, canvasDraw, shouldStartAtEdge) => {
		const { enablePanAndZoom } = canvasDraw.props;
		e.preventDefault();

		// We're going to transition immediately into lazy-drawing mode if
		// pan-and-zoom isn't enabled or if this event wasn't triggered by a touch.
		if (!e.touches || !e.touches.length || !enablePanAndZoom) {
			return new DrawingState().handleDrawStart(
				e,
				canvasDraw,
				shouldStartAtEdge
			);
		}

		// If we already have two touch events, we can move straight into pinch/pan
		if (enablePanAndZoom && e.touches && e.touches.length >= 2) {
			return new ScaleOrPanState().handleDrawStart(e, canvasDraw);
		}

		return this.handleDrawMove(e, canvasDraw);
	};

	handleDrawMove = (e, canvasDraw) => {
		e.preventDefault();

		// If we have two touches, move to pinch/pan (we don't have to recheck
		// whether zoom is enabled because that happend in draw start).
		if (e.touches && e.touches.length >= 2) {
			// Use the start draw to handler to transition.
			return new ScaleOrPanState().handleDrawStart(e, canvasDraw);
		}

		const clientPt = clientPointFromEvent(e);
		this.deferredPoints.push(clientPt);

		// If we've already moved far enough, or if enough time has passed, give up
		// and switch over to drawing.
		if (new Date().valueOf() - this.startTimestamp < PINCH_TIMEOUT_MS) {
			if (this.startClientPoint === null) {
				this.startClientPoint = clientPt;
			}

			// Note that we're using "manhattan distance" rather than computing a
			// hypotenuse here as a cheap approximation
			const d =
				Math.abs(clientPt.clientX - this.startClientPoint.clientX) +
				Math.abs(clientPt.clientY - this.startClientPoint.clientY);

			if (d < TOUCH_SLOP) {
				// We're not ready to give up yet.
				return this;
			}
		}

		// Okay, give up and start drawing.
		return this.issueDeferredPoints(canvasDraw);
	};

	handleDrawEnd = (e, canvasDraw) => {
		// The user stopped drawing before we decided what to do. Just treat this as
		// if they were drawing all along.
		return this.issueDeferredPoints(canvasDraw).handleDrawEnd(e, canvasDraw);
	};

	issueDeferredPoints = (canvasDraw) => {
		// Time to give up. Play our deferred points out to the drawing state.
		// The first point will have been a start draw.
		let nextState = new DrawingState();
		for (let i = 0; i < this.deferredPoints.length; i++) {
			const deferredPt = this.deferredPoints[i];
			const syntheticEvt = new SyntheticEvent(deferredPt);
			const func =
				i === 0 ? nextState.handleDrawStart : nextState.handleDrawMove;
			nextState = func(syntheticEvt, canvasDraw);
		}
		return nextState;
	};
}

/**
 * This state is active when the user has added at least two touch points but we
 * don't yet know if they intend to pan or zoom.
 */
export class ScaleOrPanState {
	handleMouseWheel = SUPPRESS_SCROLL.bind(this);

	handleDrawStart = (e, canvasDraw) => {
		e.preventDefault();
		if (!e.touches || e.touches.length < 2) {
			return new DefaultState();
		}
		this.start = this.getTouchMetrics(e);
		this.panStart = {
			x: canvasDraw.coordSystem.x,
			y: canvasDraw.coordSystem.y,
		};
		this.scaleStart = canvasDraw.coordSystem.scale;
		return this;
	};

	handleDrawMove = (e, canvasDraw) => {
		e.preventDefault();
		if (!e.touches || e.touches.length < 2) {
			return new DefaultState();
		}

		const { centroid, distance } = (this.recentMetrics =
			this.getTouchMetrics(e));

		// Switch to scaling?
		const dd = Math.abs(distance - this.start.distance);
		if (dd >= TOUCH_SLOP) {
			return new TouchScaleState(this).handleDrawMove(e, canvasDraw);
		}

		// Switch to panning?
		const dx = centroid.clientX - this.start.centroid.clientX;
		const dy = centroid.clientY - this.start.centroid.clientY;
		const dc = Math.abs(dx) + Math.abs(dy);
		if (dc >= TOUCH_SLOP) {
			return new TouchPanState(this).handleDrawMove(e, canvasDraw);
		}

		// Not enough movement yet
		return this;
	};

	handleDrawEnd = () => new DefaultState();

	getTouchMetrics = (e) => {
		const { clientX: t1x, clientY: t1y } = clientPointFromEvent(e.touches[0]);
		const { clientX: t2x, clientY: t2y } = clientPointFromEvent(e.touches[1]);

		const dx = t2x - t1x;
		const dy = t2y - t1y;

		return {
			t1: { clientX: t1x, clientY: t1y },
			t2: { clientX: t2x, clientY: t2y },
			distance: Math.sqrt(dx * dx + dy * dy),
			centroid: { clientX: (t1x + t2x) / 2.0, clientY: (t1y + t2y) / 2.0 },
		};
	};
}

/**
 * The user is actively using touch gestures to pan the image.
 */
export class TouchPanState {
	constructor(scaleOrPanState) {
		this.scaleOrPanState = scaleOrPanState;
	}

	handleMouseWheel = SUPPRESS_SCROLL.bind(this);
	handleDrawStart = () => this;

	handleDrawMove = (e, canvasDraw) => {
		e.preventDefault();
		if (!e.touches || e.touches.length < 2) {
			return new DefaultState();
		}

		const ref = this.scaleOrPanState;
		const { centroid, distance } = (ref.recentMetrics = ref.getTouchMetrics(e));

		const dx = centroid.clientX - ref.start.centroid.clientX;
		const dy = centroid.clientY - ref.start.centroid.clientY;

		canvasDraw.setView({ x: ref.panStart.x + dx, y: ref.panStart.y + dy });

		return this;
	};

	handleDrawEnd = () => new DefaultState();
}

/**
 * The user is actively using touch gestures to scale the drawing.
 */
export class TouchScaleState {
	constructor(scaleOrPanState) {
		this.scaleOrPanState = scaleOrPanState;
	}

	handleMouseWheel = SUPPRESS_SCROLL.bind(this);
	handleDrawStart = () => this;

	handleDrawMove = (e, canvasDraw) => {
		e.preventDefault();
		if (!e.touches || e.touches.length < 2) {
			return new DefaultState();
		}

		const ref = this.scaleOrPanState;
		const { centroid, distance } = (ref.recentMetrics = ref.getTouchMetrics(e));

		const targetScale = ref.scaleStart * (distance / ref.start.distance);
		const dScale = targetScale - canvasDraw.coordSystem.scale;
		canvasDraw.coordSystem.scaleAtClientPoint(dScale, centroid);

		return this;
	};

	handleDrawEnd = () => new DefaultState();
}

/**
 * This state is active when the user is drawing.
 */
export class DrawingState {
	constructor() {
		this.isDrawing = false;
	}

	handleMouseWheel = SUPPRESS_SCROLL.bind(this);

	handleDrawStart = (e, canvasDraw, shouldStartAtEdge) => {
		console.log('SHOULD START EDGE ' + shouldStartAtEdge);
		e.preventDefault();

		if (e.touches && e.touches.length) {
			// on touch, set catenary position to touch pos
			const { x, y } = viewPointFromEvent(canvasDraw.coordSystem, e);

			canvasDraw.lazy.update({ x, y }, { both: true });
		}

		return this.handleDrawMove(e, canvasDraw, shouldStartAtEdge);
	};

	handleDrawMove = (e, canvasDraw, shouldStartAtEdge) => {
		console.log('DRAW MOVE B');
		e.preventDefault();
		const realCanvasWidth = canvasDraw.canvas.drawing.clientWidth;
		const realCanvasHeight = canvasDraw.canvas.drawing.clientHeight;
		let { x, y } = viewPointFromEvent(canvasDraw.coordSystem, e);
		canvasDraw.lastX = x;
		canvasDraw.lastY = y;
		console.log('TOOL ', canvasDraw.props.tool);
		if (canvasDraw.props.tool === 'FloodFill') {
			// const imageData = canvasDraw.canvas.drawing
			// 	.getContext('2d')
			// 	.getImageData(0, 0, realCanvasWidth, realCanvasHeight);
			// console.log('IMAGE DATA ', imageData);
			// const col = { r: 0xff, g: 0xff, b: 0x0, a: 0xff };
			// canvasDraw.floodFill(
			// 	canvasDraw.ctx.drawing,
			// 	canvasDraw.canvas.drawing,
			// 	0xff0000ff,
			// 	x,
			// 	y
			// );

			// get 2d context
			const context = canvasDraw.ctx.drawing;
			// get image data
			const imgData = context.getImageData(
				0,
				0,
				realCanvasWidth,
				realCanvasHeight
			);
			function hexColorToHexString(hexColor) {
				const prefix = hexColor.split('#');
				return `0x${prefix[1].charAt(0)}${prefix[1].charAt(0)}${prefix[1]}`;
			}

			canvasDraw.floodFill(
				context,
				Math.round(x),
				Math.round(y),
				canvasDraw.props.brushColor
			);

			// // Construct flood fill instance
			// const floodFill = new FloodFill(imgData);
			// // Modify image data
			// floodFill.fill(canvasDraw.props.brushColor, Math.ceil(x), Math.ceil(y), 0);
			// // put the modified data back in context
			// context.putImageData(floodFill.imageData, 0, 0);
		}
		if (canvasDraw.props.tool === 'Rectangle') {
			canvasDraw.drawRect();
		}
		if (canvasDraw.props.tool === 'Circle') {
			canvasDraw.drawCircle();
			// canvasDraw.drawPoints({
			//   points: canvasDraw.allDrawnPoints,
			//   brushColor: canvasDraw.props.brushColor,
			//   brushRadius: canvasDraw.props.brushRadius,
			// });
			// Draw current points
		}
		if (
			canvasDraw.props.tool !== 'Pencil' &&
			canvasDraw.props.tool !== 'Eraser'
		)
			return this;

		if (shouldStartAtEdge) {
			const offset = 80;

			if (canvasDraw.lastX < 0 && x < offset) {
				//left side exit
				x = 0;
			} else if (
				canvasDraw.lastX >= realCanvasWidth &&
				x >= realCanvasWidth - offset
			) {
				//right side exit
				console.log('right side exit');
				x += 500;
			}

			if (canvasDraw.lastY < 0 && y < offset) {
				//top side exit
				y = 0;
			} else if (
				canvasDraw.lastY >= realCanvasHeight &&
				y >= realCanvasHeight - offset
			) {
				//bottom side exit
				y += 500;
			}

			// if(canvasDraw.las)
			// x = canvasDraw.lastX;
			// y = canvasDraw.lastY;
			//FIGURE OUT WHICH SIDE WE'RE ENTERING FROM

			//if we
			// if(x < offset &&
		} else {
			console.log('handling move ', x, y);
			canvasDraw.lastX = x;
			canvasDraw.lastY = y;
		}
		canvasDraw.lazy.update({ x, y });
		const isDisabled = !canvasDraw.lazy.isEnabled();

		if (!this.isDrawing || isDisabled) {
			// Start drawing and add point
			canvasDraw.points.push(
				canvasDraw.clampPointToDocument(canvasDraw.lazy.brush.toObject())
			);
			this.isDrawing = true;
		}

		// Add new point
		canvasDraw.points.push(
			canvasDraw.clampPointToDocument(canvasDraw.lazy.brush.toObject())
		);

		// Draw current points
		canvasDraw.drawPoints({
			points: canvasDraw.points,
			brushColor:
				canvasDraw.props.tool === 'Eraser'
					? '#FFFFFF'
					: canvasDraw.props.brushColor,
			brushRadius: canvasDraw.props.brushRadius,
		});

		return this;
	};

	handleDrawEnd = (e, canvasDraw) => {
		e.preventDefault();

		// Draw to this end pos
		this.handleDrawMove(e, canvasDraw);
		canvasDraw.saveLine();

		return new DefaultState();
	};
}

export class SyntheticEvent {
	constructor({ clientX, clientY }) {
		this.clientX = clientX;
		this.clientY = clientY;
		this.touches = [{ clientX, clientY }];
	}

	preventDefault = () => {};
}

export function clientPointFromEvent(e) {
	// use cursor pos as default
	let clientX = e.clientX;
	let clientY = e.clientY;

	// use first touch if available
	if (e.changedTouches && e.changedTouches.length > 0) {
		clientX = e.changedTouches[0].clientX;
		clientY = e.changedTouches[0].clientY;
	}

	return { clientX, clientY };
}

export function viewPointFromEvent(coordSystem, e) {
	return coordSystem.clientPointToViewPoint(clientPointFromEvent(e));
}
