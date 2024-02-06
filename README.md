![1](https://github.com/SandeepKomal/Docker/assets/99358567/cb406a6a-ae5f-4ffa-92f9-3371e39ef888)

![2](https://github.com/SandeepKomal/Docker/assets/99358567/23c68285-0043-4bb8-a7a4-7536e85c00df)

![3](https://github.com/SandeepKomal/Docker/assets/99358567/0e2d7baa-d15b-48c7-8a0d-8833ccdd9f21)

![4](https://github.com/SandeepKomal/Docker/assets/99358567/a359473b-4ff4-494e-8b21-ea1c25261475)

![5](https://github.com/SandeepKomal/Docker/assets/99358567/e4cf3416-04ad-44cc-9e8f-4323f7481a1a)

#######Some Important Git commands #######

![1](https://github.com/SandeepKomal/Docker/assets/99358567/30917834-35a2-4091-a0f4-63986ec02447)

![2](https://github.com/SandeepKomal/Docker/assets/99358567/12763fd7-e1b3-4a71-8c03-a98e3af0906f)

![3](https://github.com/SandeepKomal/Docker/assets/99358567/45914b6b-caff-433e-b76c-2c400b292d2b)

![4](https://github.com/SandeepKomal/Docker/assets/99358567/13cf25ea-4b56-42c7-9a81-458ab8ca35d9)


########  Docker commands pdf ########

[docker commands pdf.pdf](https://github.com/SandeepKomal/Docker/files/13972929/docker.commands.pdf.pdf)



# &lt;clipboard-copy&gt; element

Copy element text content or input values to the clipboard.

## Installation

```
$ npm install --save @github/clipboard-copy-element
```

## Usage

### Script

Import as ES modules:

```js
import '@github/clipboard-copy-element'
```

With a script tag:

```html
<script type="module" src="./node_modules/@github/clipboard-copy-element/dist/index.js">
```

### Markup

```html
<clipboard-copy for="blob-path" class="btn btn-sm BtnGroup-item">
  Copy path
</clipboard-copy>
<div id="blob-path">src/index.js</div>
```

## Data sources

### Attribute

```html
<clipboard-copy value="src/index.js">Copy</clipboard-copy>
```

### Element content

```html
<clipboard-copy for="blob-path">Copy</clipboard-copy>
<div id="blob-path">src/index.js</div>
```

### Form input

```html
<clipboard-copy for="blob-path">Copy</clipboard-copy>
<input id="blob-path" value="src/index.js">
```

### Hyperlink href

```html
<clipboard-copy for="blob-path">Copy full URL</clipboard-copy>
<a id="blob-path" href="/path/to#my-blob">Link text will not be copied</a>
```

## Events

After copying to the clipboard, a `clipboard-copy` event is dispatched from
the `<clipboard-copy>` element:

```js
document.addEventListener('clipboard-copy', function(event) {
  const button = event.target
  button.classList.add('highlight')
})
```

## Browser support

Browsers without native [custom element support][support] require a [polyfill][].

- Chrome
- Firefox
- Safari
- Microsoft Edge

[support]: https://caniuse.com/#feat=custom-elementsv1
[polyfill]: https://github.com/webcomponents/polyfills/tree/master/packages/custom-elements

## Development

```
npm install
npm test
```

## License

Distributed under the MIT license. See LICENSE for details.





