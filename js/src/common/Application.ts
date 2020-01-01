import Mithril from "mithril";

import Bus from './Bus';
import Translator from './Translator';
import Session from './Session';
import Store from './Store';

import extract from './utils/extract';
import mapRoutes from './utils/mapRoutes';
import Drawer from './utils/Drawer';
import {extend} from './extend';

import Forum from './models/Forum';
import Discussion from './models/Discussion';
import User from './models/User';
import Post from './models/Post';
import Group from './models/Group';
import Notification from './models/Notification';

import RequestError from './utils/RequestError';
import Alert from './components/Alert';
import ModalManager from './components/ModalManager';

export type ApplicationData = {
    apiDocument: any;
    locale: string;
    locales: any;
    resources: any[];
    session: any;
};

export default abstract class Application {
    /**
     * The forum model for this application.
     */
    forum: Forum;

    data: ApplicationData;

    translator = new Translator();
    bus = new Bus();

    /**
     * The app's session.
     */
    session: Session;

    /**
     * The app's data store.
     */
    store = new Store({
        forums: Forum,
        users: User,
        discussions: Discussion,
        posts: Post,
        groups: Group,
        notifications: Notification
    });

    drawer = new Drawer();

    modal: ModalManager;

    /**
     * A local cache that can be used to store data at the application level, so
     * that is persists between different routes.
     */
    cache = {};

    routes = {};

    title = '';
    titleCount = 0;

    /**
     * An Alert that was shown as a result of an AJAX request error. If present,
     * it will be dismissed on the next successful request.
     */
    private requestError: Alert = null;

    mount(basePath = '') {
        m.mount(document.getElementById('modal'), new ModalManager());

        // this.alerts = m.mount(document.getElementById('alerts'), <AlertManager />);

        m.route(document.getElementById('content'), basePath + '/', mapRoutes(this.routes, basePath));
    }

    boot(payload: any) {
        this.data = payload;

        this.store.pushPayload({ data: this.data.resources });

        this.forum = this.store.getById('forums', 1);

        this.session = new Session(
            this.store.getById('users', this.data.session.userId),
            this.data.session.csrfToken
        );

        this.locale();
        this.plugins();
        this.setupRoutes();
        this.mount();

        this.bus.dispatch('app.booting');
    }

    locale() {
        this.translator.locale = this.data.locale;

        this.bus.dispatch('app.locale');
    }

    plugins() {
        this.bus.dispatch('app.plugins');
    }

    setupRoutes() {
        this.bus.dispatch('app.routes');
    }

    /**
     * Get the API response document that has been preloaded into the application.
     */
    preloadedApiDocument() {
      if (this.data.apiDocument) {
        const results = this.store.pushPayload(this.data.apiDocument);

        this.data.apiDocument = null;

        return results;
      }

      return null;
    }

    /**
     * Set the <title> of the page.
     */
    setTitle(title: string) {
        this.title = title;
        this.updateTitle();
    }

    /**
     * Set a number to display in the <title> of the page.
     */
    setTitleCount(count: number) {
        this.titleCount = count;
        this.updateTitle();
    }

    updateTitle() {
        document.title = (this.titleCount ? `(${this.titleCount}) ` : '') +
          (this.title ? this.title + ' - ' : '') +
          this.forum.attribute('title');
    }

    /**
     * Construct a URL to the route with the given name.
     */
    route(name: string, params: object = {}): string {
        const route = this.routes[name];

        if (!route) throw new Error(`Route '${name}' does not exist`);

        const url = route.path.replace(/:([^\/]+)/g, (m, key) => extract(params, key));
        const queryString = m.buildQueryString(params);
        const prefix = m.route.prefix === '' ? this.forum.attribute('basePath') : '';

        return prefix + url + (queryString ? '?' + queryString : '');
    }

    /**
     * Make an AJAX request, handling any low-level errors that may occur.
     *
     * @see https://mithril.js.org/request.html
     */
    request(originalOptions: Mithril.RequestOptions|any): Promise<any> {
      const options: Mithril.RequestOptions = Object.assign({}, originalOptions);

      // Set some default options if they haven't been overridden. We want to
      // authenticate all requests with the session token. We also want all
      // requests to run asynchronously in the background, so that they don't
      // prevent redraws from occurring.
      options.background = options.background || true;

      extend(options, 'config', (result, xhr: XMLHttpRequest) => xhr.setRequestHeader('X-CSRF-Token', this.session.csrfToken));

      // If the method is something like PATCH or DELETE, which not all servers
      // and clients support, then we'll send it as a POST request with the
      // intended method specified in the X-HTTP-Method-Override header.
      if (options.method !== 'GET' && options.method !== 'POST') {
        const method = options.method;
        extend(options, 'config', (result, xhr: XMLHttpRequest) => xhr.setRequestHeader('X-HTTP-Method-Override', method));
        options.method = 'POST';
      }

      // When we deserialize JSON data, if for some reason the server has provided
      // a dud response, we don't want the application to crash. We'll show an
      // error message to the user instead.
      options.deserialize = options.deserialize || (responseText => responseText);

      options.errorHandler = options.errorHandler || (error => {
        throw error;
      });

      // When extracting the data from the response, we can check the server
      // response code and show an error message to the user if something's gone
      // awry.
      const original = options.extract;
      options.extract = xhr => {
        let responseText;

        if (original) {
          responseText = original(xhr.responseText);
        } else {
          responseText = xhr.responseText || null;
        }

        const status = xhr.status;

        if (status < 200 || status > 299) {
          throw new RequestError(status, responseText, options, xhr);
        }

        if (xhr.getResponseHeader) {
          const csrfToken = xhr.getResponseHeader('X-CSRF-Token');
          if (csrfToken) app.session.csrfToken = csrfToken;
        }

        try {
          return JSON.parse(responseText);
        } catch (e) {
          throw new RequestError(500, responseText, options, xhr);
        }
      };

      // TODO: ALERT MANAGER
      // if (this.requestError) this.alerts.dismiss(this.requestError.alert);

      // Now make the request. If it's a failure, inspect the error that was
      // returned and show an alert containing its contents.
      // const deferred = m.deferred();

      // return new Promise((resolve, reject) => )

      return m.request(options)
        .then(res => res, error => {
        this.requestError = error;

        let children;

        switch (error.status) {
          case 422:
            children = error.response.errors
              .map(error => [error.detail, m('br')])
              .reduce((a, b) => a.concat(b), [])
              .slice(0, -1);
            break;

          case 401:
          case 403:
            children = this.translator.trans('core.lib.error.permission_denied_message');
            break;

          case 404:
          case 410:
            children = this.translator.trans('core.lib.error.not_found_message');
            break;

          case 429:
            children = this.translator.trans('core.lib.error.rate_limit_exceeded_message');
            break;

          default:
            children = this.translator.trans('core.lib.error.generic_message');
        }

        error.alert = Alert.component({
          type: 'error',
          children
        });

        try {
          options.errorHandler(error);
        } catch (error) {
            console.error(error);
          // this.alerts.show(error.alert);
        }

        return Promise.reject(error);
      });

      // return deferred.promise;
    }
}