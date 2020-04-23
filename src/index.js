import {
  toVNodes,
  camelize,
  hyphenate,
  callHooks,
  injectHook,
  getInitialProps,
  createCustomEvent,
  convertAttributeValue
} from './utils.js'

export default function wrap(Vue, Component) {
  const isAsync = typeof Component === 'function' && !Component.cid
  let isInitialized = false
  let hyphenatedPropsList
  let camelizedPropsList
  let camelizedPropsMap

  function initialize(Component) {
    if (isInitialized) return

    const options =
      typeof Component === 'function' ? Component.options : Component

    // extract props info
    const propsList = Array.isArray(options.props)
      ? options.props
      : Object.keys(options.props || {})
    hyphenatedPropsList = propsList.map(hyphenate)
    camelizedPropsList = propsList.map(camelize)
    const originalPropsAsObject = Array.isArray(options.props)
      ? {}
      : options.props || {}
    camelizedPropsMap = camelizedPropsList.reduce((map, key, i) => {
      map[key] = originalPropsAsObject[propsList[i]]
      return map
    }, {})

    // proxy $emit to native DOM events
    injectHook(options, 'beforeCreate', function () {
      const emit = this.$emit
      this.$emit = (name, ...args) => {
        this.$root.$options.customElement.dispatchEvent(
          createCustomEvent(name, args)
        )
        return emit.call(this, name, ...args)
      }
    })

    injectHook(options, 'created', function () {
      // sync default props values to wrapper on created
      camelizedPropsList.forEach((key) => {
        this.$root.props[key] = this[key]
      })
    })

    // proxy props as Element properties
    camelizedPropsList.forEach((key) => {
      Object.defineProperty(CustomElement.prototype, key, {
        get() {
          return this._wrapper.props[key]
        },
        set(newVal) {
          this._wrapper.props[key] = newVal
        },
        enumerable: false,
        configurable: true
      })
    })

    isInitialized = true
  }

  function syncAttribute(el, key) {
    const camelized = camelize(key)
    const value = el.hasAttribute(key) ? el.getAttribute(key) : undefined
    el._wrapper.props[camelized] = convertAttributeValue(
      value,
      key,
      camelizedPropsMap[camelized]
    )
  }

  class CustomElement extends HTMLElement {
    constructor() {
      const self = super()
      self.attachShadow({ mode: 'open' })

      const wrapper = (self._wrapper = new Vue({
        name: 'shadow-root',
        customElement: self,
        shadowRoot: self.shadowRoot,
        data() {
          return {
            props: {},
            slotChildren: [],
            ShadyDOMSlotsHack_slotsPassedToWrapper: false,
            ShadyDOMSlotsHack_deregisterSetIntervalListener: null
          }
        },
        render(h) {
          return h(
            Component,
            {
              ref: 'inner',
              props: this.props
            },
            this.slotChildren
          )
        }
      }))

      if (window.ShadyDOM) {
        // MutationObserver does not work inside shadowRoot when polyfilled with ShadyDOM
        // this makes slot changes go unrecognized by our usage of MutationObserver
        // https://github.com/webcomponents/polyfills/issues/81

        // ShadyDOM has a function called ShadyDOM.childrenObserver but it doesn't do the job very thoroughly, as it
        // cannot recognize changes in slots when the slot count hasn't changed, and seemingly doesn't recognized removal of elements (https://github.com/webcomponents/polyfills/issues/82)
        // .. what it can do for us however, is to observe whether slots are ever added.
        // once a slot is added, we'll apply the hack to this wrapper.
        // if slots are never used, we're saving ourselves some performance cost.
        window.ShadyDOM.observeChildren(this, () => {
          if (!wrapper.ShadyDOMSlotsHack_slotsPassedToWrapper) {
            wrapper.ShadyDOMSlotsHack_slotsPassedToWrapper = true
          }
        })

        // Here is the ugly fix to work around the core issue, basically setInterval, but shared across all vue wc wrappers for performance
        // we preserve the original MutationObserver code further down, because it observes all other changes for us.
        window.ShadyDOMSlotsHack_setInterval =
          window.ShadyDOMSlotsHack_setInterval ||
          // eslint-disable-next-line no-extra-parens
          new (function () {
            this.listeners = []

            this.add = (handler) => {
              const id = Math.floor(Math.random() * 1000000)
              this.listeners.push({
                handler,
                id
              })

              if (this.listeners.length === 1) {
                // first entry added, start setInterval
                this.start()
              }
              return id
            }

            this.remove = (idToRemove) => {
              this.listeners.splice(
                this.listeners.findIndex(({ id }) => id === idToRemove),
                1
              )

              if (this.listeners.length === 0) {
                // no entries left, stop setInterval
                this.stop()
              }
            }

            this.start = () => {
              if (this.intervalId === undefined || this.intervalId === null) {
                this.intervalId = window.setInterval(() => {
                  this.listeners.forEach(({ handler }) => handler())
                }, 100)
              }
            }

            this.stop = () => {
              if (this.intervalId) {
                window.clearInterval(this.intervalId)
                this.intervalId = null
              }
            }
          })()

        const id = window.ShadyDOMSlotsHack_setInterval.add(() => {
          if (wrapper.ShadyDOMSlotsHack_slotsPassedToWrapper) {
            // slots were added to the wrapper at some point, so update children at every interval
            this.updateSlotChildren()
          }
        })

        wrapper.ShadyDOMSlotsHack_deregisterSetIntervalListener = () =>
          window.ShadyDOMSlotsHack_setInterval.remove(id)
      }

      // Use MutationObserver to react to future attribute & slot content change
      const observer = new MutationObserver((mutations) => {
        let hasChildrenChange = false
        for (let i = 0; i < mutations.length; i++) {
          const m = mutations[i]
          if (isInitialized && m.type === 'attributes' && m.target === self) {
            syncAttribute(self, m.attributeName)
          } else {
            hasChildrenChange = true
          }
        }
        if (hasChildrenChange) {
          this.updateSlotChildren()
        }
      })
      observer.observe(self, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true
      })
    }

    get vueComponent() {
      return this._wrapper.$refs.inner
    }

    updateSlotChildren() {
      this._wrapper.slotChildren = Object.freeze(
        toVNodes(this._wrapper.$createElement, this.childNodes)
      )

      if (this._wrapper.slotChildren.length === 0) {
        // no slots present, revert the shadyDOM hack (if present)
        this._wrapper.ShadyDOMSlotsHack_slotsPassedToWrapper = false
      }
    }

    async connectedCallback() {
      const wrapper = this._wrapper

      // TODO: Vue's router will be instantiated immediately, before the router
      // in `mover-app` has finished transitioning URLs, making the Vue router
      // resolve the wrong URL. Wait one micro-task to allow `mover-app`'s
      // router to finish transitioning.
      await Promise.resolve()

      if (!wrapper._isMounted) {
        // initialize attributes
        const syncInitialAttributes = () => {
          wrapper.props = getInitialProps(camelizedPropsList)
          hyphenatedPropsList.forEach((key) => {
            syncAttribute(this, key)
          })
        }

        if (isInitialized) {
          syncInitialAttributes()
        } else {
          // async & unresolved
          Component().then((resolved) => {
            if (
              resolved.__esModule ||
              resolved[Symbol.toStringTag] === 'Module'
            ) {
              resolved = resolved.default
            }
            initialize(resolved)
            syncInitialAttributes()
          })
        }
        // initialize children
        this.updateSlotChildren()
        wrapper.$mount()
        this.shadowRoot.appendChild(wrapper.$el)
      } else {
        callHooks(this.vueComponent, 'activated')
      }
    }

    disconnectedCallback() {
      if (
        this._wrapper &&
        this._wrapper.ShadyDOMSlotsHack_deregisterSetIntervalListener
      ) {
        this._wrapper.ShadyDOMSlotsHack_deregisterSetIntervalListener()
      }

      callHooks(this.vueComponent, 'deactivated')
    }
  }

  if (!isAsync) {
    initialize(Component)
  }

  return CustomElement
}
