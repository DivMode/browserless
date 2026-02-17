// CDP bug: Input.dispatchMouseEvent sets screenX=clientX, screenY=clientY
// Real events: screenX = clientX + window.screenX, screenY = clientY + window.screenY + chromeHeight
// Reference: https://github.com/TheFalloutOf76/CDP-bug-MouseEvent-.screenX-.screenY-patcher
//
// Hardened with Proxy + toString spoofing from puppeteer-extra-plugin-stealth
// so getOwnPropertyDescriptor().get.toString() returns "[native code]"
(function() {
  const chromeHeight = 85; // toolbar + tabs height (approx)

  // Save originals before any page script can tamper
  const origGetOwnPropDesc = Object.getOwnPropertyDescriptor;
  const origScreenXDesc = origGetOwnPropDesc.call(Object, MouseEvent.prototype, 'screenX');
  const origScreenYDesc = origGetOwnPropDesc.call(Object, MouseEvent.prototype, 'screenY');
  const origScreenXGet = origScreenXDesc && origScreenXDesc.get;
  const origScreenYGet = origScreenYDesc && origScreenYDesc.get;

  // Spoof a function's toString to return "[native code]" like the original
  function spoofToString(fake, original) {
    const handler = {
      apply: function(target, thisArg, args) {
        // If called on our fake getter, return what the original would say
        if (thisArg === fake) {
          return Function.prototype.toString.call(original || function() {});
        }
        return Reflect.apply(target, thisArg, args);
      }
    };
    // Only patch toString for our fake function
    fake.toString = new Proxy(Function.prototype.toString, handler);
    return fake;
  }

  // Create hardened getters that look native under introspection
  const fakeScreenXGet = spoofToString(
    function screenX() { return this.clientX + (window.screenX || 0); },
    origScreenXGet
  );
  const fakeScreenYGet = spoofToString(
    function screenY() { return this.clientY + (window.screenY || 0) + chromeHeight; },
    origScreenYGet
  );

  Object.defineProperty(MouseEvent.prototype, 'screenX', {
    get: fakeScreenXGet,
    configurable: true,
    enumerable: true,
  });
  Object.defineProperty(MouseEvent.prototype, 'screenY', {
    get: fakeScreenYGet,
    configurable: true,
    enumerable: true,
  });
})();
