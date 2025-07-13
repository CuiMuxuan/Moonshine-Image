const routes = [
  {
    path: "/",
    component: () => import("layouts/MainLayout.vue"),
    children: [
      {
        path: "",
        redirect: "/image"
      },
      {
        path: "image",
        component: () => import("pages/IndexPage.vue"),
        props: true
      },
      {
        path: "video",
        component: () => import("pages/VideoPage.vue"),
        props: true
      },
    ],
  },

  // Always leave this as last one,
  // but you can also remove it
  {
    path: "/:catchAll(.*)*",
    component: () => import("pages/ErrorNotFound.vue"),
  },
];

export default routes;
