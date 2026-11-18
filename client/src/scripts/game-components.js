
/**
 * Class for showing Token amount.
 */
class Token extends HTMLElement {
    static get observedAttributes() {
        return ["count"];
    }

    constructor() {
        super();
        this.color = null;
        this.count = 0;
    }

    connectedCallback() {
        this.color = this.getAttribute("color");

        if(this.hasAttribute("count")) {
            this.count = parseInt(this.getAttribute("count"));
        }

        const capitalizeColor = this.color[0].toUpperCase() + this.color.slice(1);

        this.innerHTML = `
            <div class="board-token ${this.color}-token" jewel-color="${capitalizeColor}">
                <span></span>
            </div>
        `;

        // do this after setting innerHTML so that when attribute callback is called, span element exists.
        this.setAttribute("count", this.count);
    }

    /**
     * Set number of tokens.
     * @param {Integer} val 
     */
    setCount(val) {
        this.count = parseInt(val);
        this.querySelector("span").innerText = this.count;
    }

    attributeChangedCallback(name, oldValue, newValue) {
        if(oldValue !== newValue) {
            this.setCount(parseInt(newValue));
        }
    }
}

/**
 * Class for creating a inc/dec able Token counter.
 */
class TokenCounter extends HTMLElement {
    constructor() {
        super();
        this.max = 0;
        this.min = 0;
        this.color = null;
    }

    connectedCallback() {
        // retrieve set color
        this.color = this.getAttribute("color");

        this.innerHTML = `
            <div class="token-count-inner-container">
                <button class="quantity-button increase" type="button" aria-label="Add ${this.color}">
                    <span>+</span>
                </button>
                <board-token color="${this.color}"></board-token>
                <button class="quantity-button decrease" type="button" aria-label="Remove ${this.color}">
                    <span>-</span>
                </button>
            </div>
        `;

        const countElm = this.querySelector("board-token");

        // setup increment and decrement
        this.querySelector(".increase").onclick = () => {
            /** @type {Token} */
            if (countElm.count < this.max) {
                this.setCount(countElm.count + 1);
            }
        };
    
        this.querySelector(".decrease").onclick = () => {
            /** @type {Token} */
            if (countElm.count > this.min) {
                this.setCount(countElm.count - 1);
            }
        };
        this.checkVisibility();
    }

    setCount(value) {
        this.querySelector("board-token").setCount(value);
        this.checkVisibility();
    }

    /**
     * Check if the inc/dec buttons should be clickable.
     * Disable the buttons at the current bounds.
     */
    checkVisibility() {
        const count = this.querySelector("board-token").count;
        this.querySelector(".increase").disabled = count >= this.max;
        this.querySelector(".decrease").disabled = count <= this.min;
    }

    /**
     * Set minimum value for this counter & checks the visibility.
     * @param {Integer} min 
     */
    setMin(min) {
        this.min = parseInt(min);
        this.checkVisibility();
    }

    /**
     * Set maximum value for this counter & checks the visibility.
     * @param {Integer} max 
     */
    setMax(max) {
        this.max = parseInt(max);
        this.checkVisibility();
    }
}

// define them so that we can use them in HTML
customElements.define("board-token", Token);
customElements.define("board-token-counter", TokenCounter);
