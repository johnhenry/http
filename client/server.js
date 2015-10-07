var URL          = require("url");
var EventEmitter = require("events").EventEmitter;
var formJSON     = require("@rill/form-json");
var Request      = require("./request.js");
var Response     = require("./response.js");
var util         = require("./util.js");
var reg          = {
	hash:          /#(.+)$/,
	rel:           /(?:^|\s+)external(?:\s+|$)/,
	cookieOptions: /(domain|path|expires|max-age|httponly|secure)( *= *[^;]*)?/g,
	cookieValues:  / *; */
};

/**
 * Emulates node js http server in the browser.
 *
 * @param {Function} handle - the handle for a request.
 */
function Server (handler) {
	this._handle          = this;
	this._started         = false;
	this._pending_refresh = null;
	if (handler) {
		if (typeof handler !== "function") {
			throw new TypeError("listener must be a function");
		}
		this.on("request", handler);
	}
}
var proto = Server.prototype = Object.create(EventEmitter.prototype);

/**
 * Listen to all url change events on a dom element and trigger the server callback.
 */
proto.listen = function listen () {
	var cb            = arguments[arguments.length - 1];
	this._onURLChange = onURLChange.bind(this);
	this._onSubmit    = onSubmit.bind(this);
	this._onClick     = onClick.bind(this);

	window.addEventListener("DOMContentLoaded", this._onURLChange);
	window.addEventListener("popstate", this._onURLChange);
	window.addEventListener("submit", this._onSubmit);
	window.addEventListener("click", this._onClick);

	if (typeof callback === "function") setTimeout(cb, 0);
	return this;
};

/**
 * Closes the server and destroys all event listeners.
 */
proto.close = function close () {
	var cb = arguments[arguments.length - 1];

	window.removeEventListener("DOMContentLoaded", this._onURLChange);
	window.removeEventListener("popstate", this._onURLChange);
	window.removeEventListener("submit", this._onSubmit);
	window.removeEventListener("click", this._onClick);

	if (typeof callback === "function") setTimeout(db, 0);
	this.emit("close");
	return this;
};

/*
 * Trigger the registered handle to navigate to a given url.
 *
 * @param {String|Object} req
 * @param {Boolean} replaceState
 * @api private
 */
proto.navigate = function navigate (req, replaceState) {
	if (typeof req === "string") req = new Request({ url: req });
	else if (!(req instanceof Request)) req = new Request(req);

	var res = new Response();

	res.once("finish", function onEnd() {
		req.complete = true;
		req.emit("finsish");
		clearTimeout(this._pending_refresh);

		// Check if we should set some cookies.
		if (res.getHeader("set-cookie")) {
			var cookies = res.getHeader("set-cookie");
			// In the browser each cookie required options, so we extract them.
			var options = (cookies.match(reg.cookieOptions) || []).join("; ");
			if (options) options = "; " + options;

			// We must set each cookie individually if there are multiple.
			cookies
				.replace(reg.cookieOptions, "")
				.split(reg.cookieValues)
				.filter(Boolean) // Ensure we don't have any empty cookies.
				.forEach(function (cookie) { document.cookie = cookie + options; });
		}

		// Check to see if a refresh was requested.
		if (res.getHeader("refresh")) {
			var parts       = res.getHeader("refresh").split("; url=");
			var timeout     = parseInt(parts[0]) * 1000;
			var redirectURL = parts[1];
			// This handles refresh headers similar to browsers.
			this._pending_refresh = setTimeout(
				this.navigate.bind(this, redirectURL, true),
				timeout
			);
		}

		// Check to see if we should redirect.
		if (res.getHeader("location")) {
			this.navigate(res.getHeader("location"));
			return;
		}

		// Check to see if we should update the url.
		if (req.method !== "GET") return;

		/*
		 * When navigating a user will be brought to the top of the page.
		 * If the urls contains a hash that is the id of an element (a target) then the target will be scrolled to.
		 * This is similar to how browsers handle page transitions natively.
		 */
		var hash = req.url.match(reg.hash);

		if (hash != null) {
			target = document.getElementById(hash[1]);
			if (target) {
				target.scrollIntoView({
					block: "start",
					behavior: "smooth"
				});
			}
		} else if (this._started) {
			window.scrollTo(0, 0);
		}

		// Started allows for the browser to handle the initial scroll position.
		this._started = true;

		// Update the href in the browser.
		history[replaceState
			? "replaceState"
			: "pushState"
		](null, "", req.url);
	}.bind(this));

	this.emit("request", req, res);
	return this;
};

/*
 * Handle an event that changed the url (popstate or page load).
 *
 * @param {Object} event
 */
function onURLChange (e) {
	this.navigate(location.href, true);
};

/*
 * Handle intercepting forms to update the url.
 *
 * @param {Object} event
 */
function onSubmit (e) {
	// Ignore canceled events.
	if (e.defaultPrevented) return;

	// Get the <form> element.
	var el = event.target;

	// Ignore clicks from linkless elements
	if (!el.action) return;

	// Ignore the click if the element has a target.
	if (el.target && el.target !== "_self") return;
	// Ignore 'rel="external"' links.
	if (el.hasAttribute("rel") && reg.rel.test(el.getAttribute("rel"))) return;

	// Use a url parser to parse URLs instead of relying on the browser
	// to do it for us (because IE).
	var url = URL.resolve(location.origin, el.action);
	// Ignore links that don't share a protocol or host with the browsers.
	if (url.indexOf(location.origin) !== 0) return;

	var data   = formJSON(el);
	var method = (el.getAttribute("method") || el.method).toUpperCase();

	if (method === "GET") {
		var parsed = URL.parse(url);
		parsed.query = util.flattenQuery(data.body);
		this.navigate(URL.format(parsed));
	} else {
		this.navigate({
			url:    url,
			method: method,
			body:   data.body,
			files:  data.files,
			headers: {
				"content-type": el.enctype
			}
		})
	}

	if (!el.hasAttribute("data-noreset")) el.reset();
	event.preventDefault();
};

/*
 * Handle intercepting link clicks to update the url.
 *
 * @param {Object} event
 */
function onClick (e) {
	// Ignore canceled events, modified clicks, and right clicks.
	if (event.defaultPrevented ||
		event.metaKey ||
		event.ctrlKey ||
		event.shiftKey ||
		event.button !== 0) return;

	// Get the <a> element.
	var el = event.target;
	while (el != null && el.nodeName !== "A") el = el.parentNode;

	// Ignore if we couldn't find a link.
	if (!el) return;

	// Ignore clicks from linkless elements
	if (!el.href) return;

	var url = el.href;
	// Ignore downloadable links.
	if (el.download) return;
	// Ignore the click if the element has a target.
	if (el.target && el.target !== "_self") return;
	// Ignore 'rel="external"' links.
	if (el.rel && reg.rel.test(el.rel)) return;

	// Use a url parser to parse URLs instead of relying on the browser
	// to do it for us (because IE).
	var url = URL.resolve(location.origin, el.href);
	// Ignore links that don't share a protocol or host with the browsers.
	if (url.indexOf(location.origin) !== 0) return;

	this.navigate(url);
	event.preventDefault();
};

module.exports = Server;