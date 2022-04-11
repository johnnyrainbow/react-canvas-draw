import React, { Component } from 'react';
import { render } from 'react-dom';

import CanvasDraw from '../../src';
import classNames from './index.css';
import silhouetteImage from './001.png';
class Demo extends Component {
	state = {
		color: '#ffc600',
		width: 400,
		height: 400,
		brushRadius: 10,
		lazyRadius: 12,
		backgroundImg:
			'https://upload.wikimedia.org/wikipedia/commons/a/a1/Nepalese_Mhapuja_Mandala.jpg',
		imgs: [
			'https://upload.wikimedia.org/wikipedia/commons/a/a1/Nepalese_Mhapuja_Mandala.jpg',
			'https://i.imgur.com/a0CGGVC.jpg',
		],
		trueMouseDown: false,
		tool: 'Pencil',
	};

	componentDidMount() {
		// let's change the color randomly every 2 seconds. fun!
		window.setInterval(() => {
			this.setState({
				color: '#' + Math.floor(Math.random() * 16777215).toString(16),
			});
		}, 2000);

		// let's change the background image every 2 seconds. fun!
		window.setInterval(() => {
			if (
				this.state.imgs &&
				this.state.imgs.length &&
				this.state.backgroundImg
			) {
				let img = '';
				let imgs = this.state.imgs;
				for (let i = 0; i < imgs.length; i++) {
					if (this.state.backgroundImg !== imgs[i]) {
						img = imgs[i];
					}
				}

				this.setState({
					backgroundImg: img,
				});
			}
		}, 2000);
	}
	render() {
		return (
			<div
				onMouseDown={() => {
					this.setState({ trueMouseDown: true });
					console.log('TRUE MOUSE DOWN');
				}}
				onMouseUp={() => {
					this.setState({ trueMouseDown: false });
					console.log('TRUE MOUSE UP');
				}}
			>
				<button
					onClick={() => {
						this.setState({ tool: 'Circle', color: '#ffc600' });
					}}
				>
					Circle
				</button>
				<button
					onClick={() => {
						this.setState({ tool: 'Rectangle', color: '#ffc600' });
					}}
				>
					Rect
				</button>
				<button
					onClick={() => {
						this.setState({ tool: 'Pencil', color: '#000000' });
					}}
				>
					Pencil
				</button>
				<button
					onClick={() => {
						this.setState({ tool: 'Eraser' });
					}}
				>
					Eraser
				</button>
				<button
					onClick={() => {
						this.setState({ tool: 'FloodFill', color: '#000000' });
					}}
				>
					Fill
				</button>
				<button
					onClick={() => {
						this.saveableCanvas.undo();
					}}
				>
					undo
				</button>
				<h1>React Canvas Draw</h1>
				<iframe
					title="GitHub link"
					src="https://ghbtns.com/github-btn.html?user=embiem&repo=react-canvas-draw&type=star&count=true"
					frameBorder="0"
					scrolling="0"
					width="160px"
					height="30px"
				/>
				<h2>default</h2>
				<p>
					This is a simple <span>{`<CanvasDraw />`}</span> component with
					default values.
				</p>
				<p>Try it out! Draw on this white canvas:</p>
				<CanvasDraw
					ref={(canvasDraw) => (this.saveableCanvas = canvasDraw)}
					trueMouseDown={this.state.trueMouseDown}
					onChange={() => console.log('onChange')}
					tool={this.state.tool}
					fillShape={false}
					hideGrid={true}
					brushColor={this.state.color}
					scale={1}
					silhouetteImage={silhouetteImage}
					backgroundColor={'#000'}
				/>
			</div>
		);
	}
}

render(<Demo />, document.querySelector('#demo'));
